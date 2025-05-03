import { connect, flushEvents } from "./mockdom.js";
import * as I from "./i.js";
import test from "./test.js";
import * as ROP from "./rop.js";

const { assert, eq, eqAt } = test;
const use = I.use;

//----------------------------------------------------------------
// Utilities
//----------------------------------------------------------------

// Call fn() and transform errors to make assertions easier.
//
const cleanError = fn => {
    try {
        return I.use(fn());
    } catch (e) {
        const pend = I.checkPending(e);
        return pend
            ? ["PENDING", pend]
            : ["ERROR", I.rootCause(e)];
    }
};

// Construct object for evaluation of fn() within a cell update, trapping
// all errors, flushing events and accumulating results until quiescent.
//
const testCell = fn => {
    const inner = I.cell(_ => cleanError(fn));
    let results = [];
    const self = I.cell(_ => void results.push(use(inner)));

    self.flush = _ => {
        use(self);
        flushEvents();
    };

    // Get most recent result
    self.get = _ => {
        self.flush();
        return results[results.length-1];
    };

    // Get all new results since last get/expect
    self.getNew = _ => {
        const start = results.length;
        self.flush();
        return results.slice(start);
    };

    // Detach cell and clean up
    self.stop = _ => {
        const lastValue = self.get();
        self.deactivate();
        flushEvents();
        return lastValue;
    };

    // Check most recent result
    self.expect = expected => eqAt(2, expected, self.get());

    // Check all results since last get/expect
    self.expectNew = (...expected) => eqAt(2, expected, self.getNew());

    return self;
};


//----------------------------------------------------------------
// Tests
//----------------------------------------------------------------

// test Pool
{
    const p = new ROP.Pool();
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
    const ndx = testCell(_ => {
        const ndx = p.add(9);
        eq(p[ndx], 9);
        eq(p.countUsed, 1);
        return ndx;
    }).stop();
    eq(ndx, 1);
    eq(p.countUsed, 0);
}

// test encode
{
    const pool = new ROP.Pool();
    const encode = ROP.makeEncoder(f => pool.add(f));
    const decode = ROP.makeDecoder(n => pool[n]);
    const values = [1, "abc", x => x, {a:1}];

    const tc = testCell(_ => {
        const ev = encode(values);
        eq(ev, '[1,"abc",{"%F":0},{"a":1}]');
        eq(pool[0], values[2]);
        eq(pool.countUsed, 1);
        return decode(ev);
    });
    tc.expect(values);
    assert(values[2] === tc.get()[2]);
    eq(pool.countUsed, 1);
    tc.stop();
    eq(pool.countUsed, 0);
}

//------------------------------------------------------------------------
// Tunnel Integration
//
// Here we test an integration of two instances of Agent and mockdom (for
// WebSocket and setTimeout) running in the same domain but connected to
// each other.
//
// A client-side cell is created to issue requests to the server.
// testCell() is used to synchronously dispatch callbacks for cell updates
// and WebSocket, and to log and inspect results.
//
//------------------------------------------------------------------------

const wsClient = new WebSocket();
const wsServer = new WebSocket();

// Client Agent: constructed with ws in CONNECTING state
const ca = new ROP.Agent(wsClient);
connect(wsServer, wsClient);
flushEvents();

// Server Agent: constructed with ws in OPEN state
const serverX = I.state();
const serverFuncs = {
    add: (x, y) => x + y,
    getX: () => serverX,
    func: (fa, fb) => ["ok", fa, fb, use(fa()) + use(fb())],
};
const sa = new ROP.Agent(wsServer, Object.values(serverFuncs));
const getRemote = (name) =>
    ca.getRemote(Object.keys(serverFuncs).indexOf(name));

// test: observe simple remote function (simple, non-reactive)
{
    const tc = testCell(_ => getRemote("add")(1, 2));
    tc.expectNew(["PENDING", "opening"], 3);
    eq(ca.observers.countUsed, 1);
    tc.stop();
    eq(0, ca.observers.countUsed);
}

// test: observe remote state cell
{
    serverX.set("a");
    const tc = testCell(_ => use(getRemote("getX")()));

    // ASSERT: observing cell is created on server side
    tc.expectNew(["PENDING", "opening"], "a");
    eq(ca.observers.countUsed, 1);
    eq(sa.updaters[0] == null, false);
    eq(serverX.outputs.size, 1);

    // ASSERT: update propagates
    serverX.set(7);
    tc.expectNew(7);

    // ASSERT: pending state propagates to client side
    serverX.setError(new I.Pending("stalled"));
    tc.expectNew(["PENDING", "stalled"]);

    // TODO: Agent should propagate observer errors without complaint, since
    //    it is part of normal operation.  A debugging mode could be set
    //    to NOT trap errors...  ideally this could be per-cell, and would
    //    prevent confusing re-throws!

    // Suppress "Error in observer" message...
    const oldlogger = I.setLogger(_ => null);
    // ASSERT: other errors propagate to client side (message only)
    serverX.setError("broken");
    tc.expectNew(["ERROR", "broken"]);
    I.setLogger(oldlogger);

    // ASSERT: observation is closed and resources are cleaned up
    serverX.set("ok");
    tc.stop();
    eq(serverX.outputs.size, 0);
    eq(ca.observers.countUsed, 0);
    eq(sa.updaters[0], null);
}

// test: marshaling functions
{
    serverX.set("123");
    const localVar = I.state("abc");
    const localGet = _ => use(localVar);

    const tc = testCell(_ => {
        const remoteGetX = getRemote("getX");
        const remoteFunc = getRemote("func");
        const result = use(remoteFunc(localGet, remoteGetX));

        // ASSERT: localGet is unwrapped on return
        const [ok, localGetOut, remoteGetXOut, catOut] = result;
        eq(ok, "ok");
        assert(localGetOut === localGet);

        // ASSERT: remote function is equivalent after round trip
        eq("123", use(remoteGetXOut()));

        return catOut;
    });

    // ASSERT: succeeds after repeated pending evaluations
    tc.expectNew(["PENDING", "opening"], "abc123");

    eq(1, ca.caps.countUsed);
    eq(4, sa.caps.countUsed);  // 3 initial + 1 now

    // ASSERT: no intervening pending result on state change
    localVar.set("ABC");
    tc.expectNew("ABC123");

    // ASSERT: observation is closed and resources are freed
    tc.stop();
    eq(0, ca.caps.countUsed);
    eq(3, sa.caps.countUsed);  // 3 initial + 1 now
}
