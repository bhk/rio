// rop.js: Remote Observation Protocol over WebSockets
//
// Agent is a ROP agent that uses the WebSocket API to communicate with its
// peer.  On the client side, an Agent will be constructed after connecting
// to a server.  On the server side, an Agent will be constructed after
// accepting a connection.
//
// [1] https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
// [2] https://github.com/websockets/ws/blob/master/doc/ws.md
//
// API
//
// agent = new Agent(websocket, initialFuncs)
//     Create a new agent to talk to a "peer" agent at the other end
//     of the `websocket`.
//
// f = agent.getRemote(NUM)
// result = f(...args...)
//
//     Call one of the peer agent's initial functions.  This must be done
//     within a cell.  Immediately, `result` will be a Pending error, but
//     later will transition to the actual result (or error state).
//
//     `f` is a wrapped function; when called it creates or reuses a cell.
//
//     `args` other than functions will be serialized.  Functions, however,
//     are sent as capabilities.  The other side will receive a function
//     that can be used to invoke the function.  If the function being
//     passed is already remoted from the peer, it will be unwrapped, so the
//     peer will receive the original peer-side function value that was
//     remoted to our side.
//

import {
    use, cell, wrap, memo, onDrop, Pending, rootCause, state,
    resultText,
    logError,
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

const makeEncoder = toOID => {
    const replacer = (k, v) =>
          typeof v == "function" ? {"%F": toOID(v)} : v;
    return value => JSON.stringify(value, replacer);
}

const makeDecoder = fromOID => {
    const restorer = (k, v) =>
          typeof v == "object" && v["%F"] != null
          ? fromOID(v["%F"])
          : v;
    return str => JSON.parse(str, restorer);
};

//----------------------------------------------------------------
// Agent
//----------------------------------------------------------------

const ropCALL = "Call";             // slot oid values...
const ropRESULT = "Result";         // slot value     [response]
const ropDROP = "Drop";             // slot
const ropACKDROP = "AckDrop";       // slot           [response]
const ropACKRESULT = "AckResult";   // slot
const ropERROR = "Error";           // name

class Agent {
    constructor(ws, initialFuncs) {
        // observers = outbound = state cells waiting on responses
        this.observers = new Pool();

        // updaters = inbound = cells invoking local functions  (inbound)
        this.updaters = [];

        // caps = local functions currently accessible by peer
        this.caps = new Pool();
        for (const f of initialFuncs || []) {
            this.caps[this.caps.alloc()] = f;
        }

        // We must re-use forwarders and observations, or else callers will
        // continually recalc, getting a new observation each time.  We can
        // wrap these at construction time, since these lifetime of the
        // wrapped forms exceeds the time when they can be called.
        this.observe = wrap(this.observe_.bind(this));

        // getRemote() returns an ordinary value; there is no PENDING/ERROR
        // state involved to no reason to return a cell.
        this.getRemote = memo(this.getRemote_.bind(this));

        this.encode = makeEncoder(this.toOID.bind(this));
        this.decode = makeDecoder(this.fromOID.bind(this));

        this.sendQueue = [];
        this.attach(ws);
    }

    attach(ws) {
        this.ws = ws;
        ws.onopen = (evt) => {
            // this.log(`onopen`);
            for (const msg of this.sendQueue) {
                // this.log(`send ${msg}`);
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
            const [type, slot, ...args] = msg;
            (type == ropCALL      ? this.onCall(slot, ...args) :
             type == ropRESULT    ? this.onResult(slot, ...args) :
             type == ropACKRESULT ? this.onAckResult(slot) :
             type == ropDROP      ? this.onDrop(slot) :
             type == ropACKDROP   ? this.onAckDrop(slot) :
             type == ropERROR     ? this.shutdown("received Error") :
             assert(false, `Unknown message type ${type}`));
        };
    }

    reportError(reason) {
        this.send(ropERROR, reason);
    }

    shutdown(reason) {
        this.log && this.log(`shutdown ${reason}`);
        this.ws.close();
    }

    onCall(slot, oid, ...args) {
        const fn = this.caps[oid];
        assert(this.updaters[slot] == null);
        const updater = cell(_ => {
            let result;
            if (typeof fn == "function") {
                try {
                    result = [0, use(fn(...args))];
                } catch (e) {
                    const cause = rootCause(e);
                    if (cause instanceof Pending) {
                        result = [1, cause.value];
                    } else {
                        // This situation can be confusing.  Stopping the
                        // server is maybe not ideal. For now, log to stdio.
                        logError(e, "Error in observer");
                        result = [2, cause.message || cause];
                    }
                }
            } else {
                result = [2, `No such function (${oid})`];
            }
            this.send(ropRESULT, slot, ...result);
        });
        updater.name = "inbound";
        use(updater);
        this.updaters[slot] = updater;
    }

    onDrop(slot) {
        const updater = this.updaters[slot];
        updater.deactivate();
        this.updaters[slot] = null;
        this.send(ropACKDROP, slot);
    }

    onResult(slot, err, value) {
        const observer = this.observers[slot];
        if (observer instanceof Object) {
            // this.log(`r[${slot}] = ${value}`);
            if (err == 0) {
                observer.set(value);
            } else {
                observer.setError(err == 1 ? new Pending(value) : value);
            }
        } else if (observer == "ZOMBIE") {
            // OK: still waiting on Drop
        } else {
            // protocol error
            this.reportError("bad slot");
            this.shutdown("bad slot");
        }
        this.send(ropACKRESULT, slot);
    }

    onAckResult(slot) {
    }

    onAckDrop(slot) {
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
            // TODO: re-establish connection
            this.shutdown(`send in bad state: ${this.ws.readyState}`);
        }
    }

    toOID(fn) {
        return (fn.$OID == null
                ? -1 - this.caps.add(fn)      // local  (negative => sender)
                : fn.$OID);                   // remote (non-neg => recipient)
    }

    fromOID(oid) {
        return (oid < 0
                ? this.getRemote(-1 - oid)    // remote (negative => sender)
                : assert(this.caps[oid]));    // local  (non-neg => recipient)
    }

    // Begin a new observation
    observe_(oid, ...args) {
        // this.log("open ..");
        const slot = this.observers.alloc();

        const observer = state(null, new Pending("opening"));
        this.observers[slot] = observer;

        // package args
        this.send(ropCALL, slot, oid, ...args);

        onDrop(() => {
            this.observers[slot] = "ZOMBIE";
            this.send(ropDROP, slot);
        });
        return observer;
    };

    getRemote_(oid) {
        // Remote functions are per (agent, oid, args)
        // (...args) -> cell
        const fwdr = (...args) => {
            // this.log && this.log(`evoke _o(${oid},${args.map(resultText)})`);
            return this.observe(oid, ...args);
        };
        fwdr.$OID = oid;
        return fwdr;
    }
}

export {
    Agent,
    Pool,
    // for testing
    makeEncoder,
    makeDecoder,
}
