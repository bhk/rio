import { connect, flushEvents } from "./mockdom.js";
import {
    use, wrap, activate, tryUse, usePending, Pending, checkPending,
    newCell, newState, logCell, getCurrentCell, setLogger, rootCause
} from "./i.js";
import { Agent, Pool, makeEncoder, makeDecoder } from "./rop.js";
import test from "./test.js";
const { assert, eq, eqAt } = test;

//----------------------------------------------------------------
// Utilities
//----------------------------------------------------------------

const newLogger = (prefix) => (...a) => console.log(prefix + ":", ...a);
const log = newLogger("rop_q");
const clog = (cell, opts) => logCell(cell, {...opts, log});

const flushEQ = (cell, value) => {
    flushEvents();
    eqAt(2, use(cell), value);
};

// Invoke fn(...args) in a cell, returning:
//   [false, pendingValue] if in progress
//   [true, result] if complete
//
const pcell = (fn, ...args) => {
    const inner = newCell(fn, ...args);
    inner.name = "pcell";
    return activate(() => usePending(inner));
};

// trap recalc of current cell, logging its state
const logRecalc = () => {
    const cell = getCurrentCell();
    const oldRecalc = cell.recalc.bind(cell);
    cell.recalc = () => (clog(), oldRecalc());
};

//----------------------------------------------------------------
// Tests
//----------------------------------------------------------------

// test Pool

{
    const p = new Pool();
    eq(p.alloc(), 0);
    eq(p.alloc(), 1);
    eq(p.countUsed, 2);
    p.free(0);
    p.free(1);
    eq(p.countUsed, 0);

    eq(p.alloc(), 1);
    eq(p.countUsed, 1);
    p.free(1);
    eq(p.countUsed, 0);

    // ASSERT: added index is automatically freed when cell is dropped
    const cell = newCell(() => p.add(9));
    const ndx = use(cell);
    eq(p[ndx], 9);
    eq(p.countUsed, 1);
    cell.deactivate();
    eq(p.countUsed, 0);
}

// test encode

{
    const pool = new Pool();
    const encode = makeEncoder(f => pool.add(f));
    const decode = makeDecoder(n => pool[n]);

    const cell = activate(() => {
        const v = [1, "abc", log, {a:1}];
        const ev = encode(v);
        eq(ev, '[1,"abc",{"%F":0},{"a":1}]');
        eq(pool[0], log);
        eq(pool.countUsed, 1);

        eq(decode(ev), v);
    });
    cell.deactivate();
    eq(pool.countUsed, 0);
}

// test Agent

const wsClient = new WebSocket();
const wsServer = new WebSocket();

// client agent is constructed with ws in CONNECTING state
const ca = new Agent(wsClient);
// ca.log = newLogger("CAgent");
connect(wsServer, wsClient);
flushEvents();

// we construct the server agent with ws in OPEN state
const serverState1 = newState();
const serverFuncs = {
    add: (x, y) => x + y,
    state: () => serverState1,
    funcTest: (fa, fb) => ["ok", fa, fb, use(fa()) + use(fb())],
};
const sa = new Agent(wsServer, Object.values(serverFuncs));
// sa.log = newLogger("SAgent");
const remote = (name) =>
    ca.getRemote(Object.keys(serverFuncs).indexOf(name));

// test: observe simple remote function (simple, non-reactive)

{
    const frAdd = remote("add");
    const cell = pcell(frAdd, 1, 2);
    eq([false, "opening"], use(cell));
    flushEQ(cell, [true, 3]);
    eq(ca.observers.countUsed, 1);
    cell.deactivate();
    flushEvents();
    eq(ca.observers.countUsed, 0);
}

// test: observe remote state cell

{
    serverState1.set("a");
    const cell = activate(() => usePending(remote("state")()));

    // ASSERT: observing cell is created on server side
    flushEQ(cell, [true, "a"]);
    eq(ca.observers.countUsed, 1);
    eq(sa.updaters[0] == null, false);
    eq(serverState1.outputs.size, 1);

    // ASSERT: update propagates
    serverState1.set(7);
    flushEQ(cell, [true, 7]);

    // ASSERT: pending state propagates to client side
    serverState1.setError(new Pending("stalled"));
    flushEQ(cell, [false, "stalled"]);

    const oldlogger = setLogger(() => null);
    // ASSERT: other errors propagate to client side (message only)
    serverState1.setError("broken");
    try {
        flushEQ(cell, "should-fail");
    } catch (e) {
        eq(rootCause(e), "broken");
    }
    setLogger(oldlogger);

    // ASSERT: observation is closed and resources are cleaned up
    serverState1.set("ok");
    cell.deactivate();
    flushEvents();
    eq(serverState1.outputs.size, 0);
    eq(ca.observers.countUsed, 0);
    eq(sa.updaters[0], null);
}

// test: marshaling functions

{
    serverState1.set("xyz");
    const ncc = ca.caps.countUsed;
    const ncs = sa.caps.countUsed;

    const localFunc = () => "abc";

    const cell = pcell(() => {
        const rmtState = remote("state");
        const rmtTest = remote("funcTest");
        const result = use(rmtTest(localFunc, rmtState));
        assert(result instanceof Array);
        const [ok, localFuncOut, rmtStateOut, catOut] = result;
        eq(ok, "ok");
        // ASSERT: localFunc is unwrapped on return
        eq(localFuncOut, localFunc);
        // ASSERT: remote function is equivalent after round trip
        const st = use(rmtStateOut());
        eq(catOut, "abc" + st);
        return st;
    });

    eq(use(cell), [false, "opening"]);

    flushEQ(cell, [true, "xyz"]);

    serverState1.set("def");
    flushEQ(cell, [true, "def"]);

    // ASSERT: observation is closed and resources are freed
    cell.deactivate();
    flushEvents();
    eq(sa.caps.countUsed, ncs);
    eq(ca.caps.countUsed, ncc);
}
