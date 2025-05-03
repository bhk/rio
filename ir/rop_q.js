import { connect, flushEvents } from "./mockdom.js";
import {
    use, cell, state, wrap, tryUse, usePending, Pending, checkPending,
    logCell, getCurrentCell, setLogger, rootCause, cellError
} from "./i.js";
import { Agent, Pool, makeEncoder, makeDecoder } from "./rop.js";
import test from "./test.js";
const { assert, eq, eqAt } = test;

//----------------------------------------------------------------
// Utilities
//----------------------------------------------------------------

// Convert cell.update() results that indicate errors to easier
// to deal with forms, suitable for matching in an assertion.
//
const describeResult = cell => {
    let v = cell.update();
    let e = cellError(v);
    let p = e && checkPending(e);
    return (p ? ["PENDING", p] :
            e ? ["ERROR", rootCause(e)] :
            v);
};

// Continue flushing events and updating a cell until quiescent, then return
// its described result.
//
const flush = cell => {
    while (flushEvents() || cell.isDirty) {
        cell.update();
    }
    return describeResult(cell);
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
    const add9 = cell(() => p.add(9));
    const ndx = add9.update();
    eq(p[ndx], 9);
    eq(p.countUsed, 1);
    add9.drop();
    eq(p.countUsed, 0);
}

// test encode
{
    const pool = new Pool();
    const encode = makeEncoder(f => pool.add(f));
    const decode = makeDecoder(n => pool[n]);
    const f1 = x => x;

    const base = cell(() => {
        const v = [1, "abc", f1, {a:1}];
        const ev = encode(v);
        eq(ev, '[1,"abc",{"%F":0},{"a":1}]');
        eq(pool[0], f1);
        eq(pool.countUsed, 1);

        eq(decode(ev), v);
        return "ok";
    });
    eq("ok", base.update());
    base.drop();
    eq(pool.countUsed, 0);
}

// test Agent

const wsClient = new WebSocket();
const wsServer = new WebSocket();

// client agent is constructed with ws in CONNECTING state
const ca = new Agent(wsClient);
connect(wsServer, wsClient);
flushEvents();

// we construct the server agent with ws in OPEN state
const serverState1 = state();
const serverFuncs = {
    add: (x, y) => x + y,
    state: () => serverState1,
    funcTest: (fa, fb) => ["ok", fa, fb, use(fa()) + use(fb())],
};
const sa = new Agent(wsServer, Object.values(serverFuncs));
const remote = (name) =>
    ca.getRemote(Object.keys(serverFuncs).indexOf(name));

// test: observe simple remote function (simple, non-reactive)

{
    const frAdd = remote("add");
    const c = cell(_ => use(frAdd(1, 2)));
    eq(["PENDING", "opening"], describeResult(c));
    eq(3, flush(c));
    eq(ca.observers.countUsed, 1);
    c.drop();
    flushEvents();
    eq(0, ca.observers.countUsed);
    flushEvents();
}

// test: observe remote state cell
{
    serverState1.set("a");
    const base = cell(_ => use(remote("state")()));
    flush(base);

    // ASSERT: observing cell is created on server side
    eq("a", base.update());
    eq(ca.observers.countUsed, 1);
    eq(sa.updaters[0] == null, false);
    eq(serverState1.outputs.size, 1);

    // ASSERT: update propagates
    serverState1.set(7);
    eq(7, flush(base));

    // ASSERT: pending state propagates to client side
    serverState1.setError(new Pending("stalled"));
    eq(["PENDING", "stalled"], flush(base));

    const oldlogger = setLogger(() => null);
    // ASSERT: other errors propagate to client side (message only)
    serverState1.setError("broken");
    eq(["ERROR", "broken"], flush(base));
    setLogger(oldlogger);

    // ASSERT: observation is closed and resources are cleaned up
    serverState1.set("ok");
    base.drop();
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

    const c = cell(() => {
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

    eq(["PENDING", "opening"], describeResult(c));
    eq("xyz", flush(c));

    serverState1.set("def");
    eq("def", flush(c));

    // ASSERT: observation is closed and resources are freed
    c.drop();
    flushEvents();
    eq(sa.caps.countUsed, ncs);
    eq(ca.caps.countUsed, ncc);
}
