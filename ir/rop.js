// rop.js: Remote Observation Protocol over WebSockets
//
// Agent implements ROP over WebSockets.  On the client side, an Agent will
// be constructed after connecting to a server.  On the server side, an
// Agent will be constructed after accepting a connection.  See:
//
//   ../doc/rop.md
//   https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
//   https://github.com/websockets/ws/blob/master/doc/ws.md
//
// Usage:
//
//   agent = new Agent(websocket, locals, remotes)
//
//     Create a new agent to talk to a "peer" agent at the other end of the
//     `websocket`.  `locals` and `remotes` describe primordial obects: the
//     local ones to be made available to the peer, and the remote ones for
//     which agent.remotes should be populated.
//
//     This can be called in the root context; the result never changes.
//
//   result = agent.remotes.name(...args)
//
//     Call one of the peer agent's initial functions.  Immediately,
//     `result` will be a Pending error, but later will transition to the
//     actual result (or error state).
//
// TODOs:
//  - Deal with protocol errors; revisit assert's
//  - Defend against malicious clients (resource limits?)
//  - Persist across WS connection failure?
//
// VOODOOs:
//  - updater cells send Result messages as side effects
//  - observer cells send Call messages as side effects


import {
    use, cell, lazy, wrap, memo, onDrop, isThunk,
    Pending, rootCause, state, resultText,
} from "./i.js";

// Protect against pollution of global namespace.  This module should work
// in Node (without MockDom.js) where WebSocket is not a global.
const WebSocket = null;

const assert = (cond, desc) => {
    if (!cond) {
        throw new Error(desc || "FAILED");
    }
    return cond;
};

//--------------------------------
// Table
//--------------------------------

// Table: A Table is an array that keeps track of used/unused status of
// elements, efficiently allocating new indices and then releasing them.

class Table extends Array {
    constructor() {
        super();
        this.next = 0;
        this.size = 0;
    }

    alloc(value) {
        const ndx = this.next;
        this.next = (ndx < this.length ? this[ndx] : this.length+1);
        this[ndx] = value;
        ++this.size;
        return ndx;
    }

    free(ndx) {
        this[ndx] = this.next;
        this.next = ndx;
        --this.size;
    }
}

// An ObjTable contains a set of values, assigning them each a small
// non-negative integer "index".  Each member has a reference count; after
// it reaches zero the index can be reused.

class ObjTable extends Array {
    constructor() {
        super();
        this.counts = new Table();     // store reference counts
        this.index = new Map();        // object -> index
    }

    reg(obj) {
        assert(obj !== undefined);
        if (this.index.has(obj)) {
            const ndx = this.index.get(obj);
            ++this.counts[ndx];
            return ndx;
        } else {
            const ndx = this.counts.alloc(1);
            this.index.set(obj, ndx);
            this[ndx] = obj;
            return ndx;
        }
    }

    dereg(ndx) {
        assert(this[ndx] !== undefined);
        if (--this.counts[ndx] == 0) {
            this.index.delete(this[ndx]);
            this[ndx] = undefined;
            this.counts.free(ndx);
        }
    }
}

//--------------------------------
// Pool
//--------------------------------

class Pool extends Array {
    constructor() {
        super();
        this.nextEmpty = null;
        this.countUsed = 0;
    }

    alloc() {
        ++this.countUsed;
        let ndx = this.length;
        if (this.nextEmpty != null) {
            ndx = this.nextEmpty;
            this.nextEmpty = this[ndx];
        }
        this[ndx] = null;
        return ndx;
    }

    free(ndx) {
        --this.countUsed;
        this[ndx] = this.nextEmpty;
        this.nextEmpty = ndx;
    }

    add(value) {
        const ndx = this.alloc();
        onDrop(() => {
            this.free(ndx);
        });
        this[ndx] = value;
        return ndx;
    }
}

// Avoid WebSocket global (browser-only)
const wsCONNECTING = 0;
const wsOPEN = 1;
const wsCLOSING = 2;
const wsCLOSED = 3;

//----------------------------------------------------------------
// Value encoding
//----------------------------------------------------------------
//
//    function   -->  ".FN"
//    thunk      -->  ".TN"
//    ".STR"     -->  "..STR"

const makeEncoder = toOID => {
    const P = ".";
    const replacer = (k, v) =>
          typeof v == "string" ? (v[0] == P  ? P + v : v) :
          typeof v == "function" ? P + "F" + toOID(v) :
          isThunk(v) ? P + "T" + toOID(v) :
          v;
    return value => JSON.stringify(value, replacer);
}

const makeDecoder = fromOID => {
    const P = ".";
    const restorer = (k, v) =>
          typeof v == "string" && v[0] == P
          ? ( v[1] == P ? v.slice(1) :
              fromOID(v[1], +v.slice(2)) )
          : v;
    return str => JSON.parse(str, restorer);
};

const encodeError = e =>
      e instanceof Error
      ? { message: e.message,
          stack: e.stack,
          cause: encodeError(e.cause) }
      : e;

const decodeError = obj => {
    if (obj instanceof Object && "message" in obj) {
        const cause = decodeError(obj.cause);
        const e = new Error(obj.message, {cause});
        e.stack = obj.stack;
        return e;
    }
    return obj;
};

//----------------------------------------------------------------
// Agent
//----------------------------------------------------------------
//
// Inbound transaction state
//
//   objects: localOID -> object (function/thunk exposed to peer)
//   updates: peerSlotNumber -> updater (cell invoking local object)
//
// Outbound transaction state
//
//   observers: ourSlotNumber -> observer (state cell holding slot results)
//   proxyOIDs: proxy -> peerOID  (for unwrapping proxies)
//   remotes: name -> proxy (to primordial remote objects)
//   observe: (oid, ...args) -> observer
//   getProxy: (oid, type) -> proxy function/thunk
//
// Other
//
//   log: logging funtion (null => disable verbose messages)
//   silenceErrors: rue => do not write errors to console
//

const msgSTART = "Start";           // slot oid values...
const msgRESULT = "Result";         // slot value     [response]
const msgEND = "End";               // slot
const msgACKEND = "AckEnd";         // slot           [response]
const msgACKRESULT = "AckResult";   // slot
const msgERROR = "Error";           // name

const condSUCCESS = 0;
const condPENDING = 1;
const condERROR = 2;

class Agent {
    constructor(ws, locals, remotes) {
        this.objects = new ObjTable();
        this.updaters = [];

        this.observers = new Table();
        this.proxyOIDs = new WeakMap();
        this.observe = memo(this.observe_.bind(this));
        this.getProxyW = memo(this.getProxyW_.bind(this))
        this.getProxy = (oid, typ) => this.getProxyW(oid, typ)[0];

        this.log = null;
        this.silenceErrors = false;

        this.encode = makeEncoder(this.toOID.bind(this));
        this.decode = makeDecoder(this.fromOID.bind(this));

        this.sendQueue = [];
        this.attach(ws);

        // Populate primordial local references
        for (const [name, obj] of Object.entries(locals)) {
            this.objects.reg(obj);
        }

        // Populate primordial remote references
        this.remotes = {};
        let remoteRef = 0;
        for (const [name, kind] of Object.entries(remotes)) {
            const type = (kind == "F" || kind instanceof Function ? "F" : "T");
            this.remotes[name] = this.getProxy(remoteRef, type);
            ++remoteRef;
        }
    }

    attach(ws) {
        this.ws = ws;
        ws.onopen = (evt) => {
            // this.log(`onopen`);
            for (const msg of this.sendQueue) {
                this.log && this.log(`send ${msg}`);
                this.ws.send(msg);
            }
            this.sendQueue = [];
        };

        ws.onerror = (evt) => {
            this.shutdown("socket error");
        };

        // onmessage: MessageEvent -> void
        ws.onmessage = (evt) => {
            this.log && this.log(`recv ${evt.data}`);
            const msg = this.decode(evt.data);
            if (!(msg instanceof Array)) {
                return this.shutdown("malformed");
            }
            const [type, slot, ...rest] = msg;
            (type == msgSTART     ? this.onStart(slot, ...rest) :
             type == msgRESULT    ? this.onResult(slot, ...rest) :
             type == msgACKRESULT ? this.onAckResult(slot) :
             type == msgEND       ? this.onEnd(slot) :
             type == msgACKEND    ? this.onAckEnd(slot) :
             type == msgERROR     ? this.shutdown("received Error") :
             assert(false, `Unknown message type ${type}`));
        };
    }

    shutdown(reason) {
        // maybe: this.send(msgERROR, reason);
        this.log && this.log(`shutdown ${reason}`);
        this.ws.close();
    }

    onStart(slot, oid, ...args) {
        const obj = this.objects[oid];
        let fn;
        if (obj instanceof Function) {
            fn = obj;
        } else {
            fn = use;
            args = [obj];
        }

        assert(this.updaters[slot] == null);
        const updater = cell(_ => {
            let result;
            try {
                result = [condSUCCESS, fn(...args)];
            } catch (e) {
                const cause = rootCause(e);
                if (cause instanceof Pending) {
                    result = [condPENDING, cause.value];
                } else {
                    if (!this.silenceErrors) {
                        console.log("** Error in observer:");
                        console.log(e);
                    }
                    result = [condERROR, encodeError(e)];
                }
            }
            this.send(msgRESULT, slot, ...result);
        });
        updater.name = "inbound";
        use(updater);
        this.updaters[slot] = updater;
    }

    onEnd(slot) {
        const updater = this.updaters[slot];
        updater.deactivate();
        this.updaters[slot] = null;
        this.send(msgACKEND, slot);
    }

    onResult(slot, cond, value) {
        const observer = this.observers[slot];
        if (observer instanceof Object) {
            observer.set([cond, value]);
        } else if (observer == "ZOMBIE") {
            // OK: still waiting on AckEnd
        } else {
            // protocol error
            this.shutdown("bad slot");
        }
        this.send(msgACKRESULT, slot);
    }

    onAckResult(slot) {
    }

    onAckEnd(slot) {
        assert(this.observers[slot] == "ZOMBIE");
        this.observers.free(slot);
    }

    send(type, slot, ...args) {
        const msg = this.encode([type, slot, ...args]);
        if (this.ws.readyState == wsOPEN) {
            this.log && this.log(`send ${msg}`);
            this.ws.send(msg);
        } else if (this.ws.readyState == wsCONNECTING) {
            this.log && this.log(`post ${msg}`);
            this.sendQueue.push(msg);
        } else {
            this.shutdown(`send in bad state: ${this.ws.readyState}`);
        }
    }

    // Used for messages to be sent, so local => negative (sender).
    toOID(fn) {
        // Unwrap if it's one of *our* proxies to a remote OID
        const oid = this.proxyOIDs.get(fn);
        if (oid != null) {
            return oid;
        }
        const ndx = this.objects.reg(fn);
        onDrop(_ => this.objects.dereg(ndx));
        return -1 - ndx;
    }

    // Used for received messages, so negative (sender) => remote.
    fromOID(type, oid) {
        return oid < 0
            ? this.getProxy(-1 - oid, type)
            : assert(this.objects[oid]);
    }

    // Get/retrieve a down proxy for remote function named by OID
    // "W" => wrap result in an array so thunks pass through `use`
    getProxyW_(oid, type) {
        const get = (...args) => {
            const [cond, value] = this.observe(oid, ...args);
            if (cond == condSUCCESS) {
                return value;
            }
            throw cond == condPENDING ? new Pending(value) :
                cond != condERROR ? new Error("ROP: bad cond") :
                new Error("ROP: remote error", {cause: decodeError(value)});
        };
        const fwdr = (type == "F" ? get : lazy(get));
        this.proxyOIDs.set(fwdr, oid);
        return [fwdr];
    }

    // Initiate a slot:  Each invocation of this method is a creation of a
    // memoized cell representing a slot.
    observe_(oid, ...args) {
        const observer = state([condPENDING, "ROP observe"]);
        const slot = this.observers.alloc(observer);
        this.send(msgSTART, slot, oid, ...args);
        onDrop(() => {
            this.observers[slot] = "ZOMBIE";
            this.send(msgEND, slot);
        });
        return observer;
    };
}

export {
    Agent,
    Pool,
    Table,
    ObjTable,
    // for testing
    makeEncoder,
    makeDecoder,
    encodeError,
    decodeError,
}
