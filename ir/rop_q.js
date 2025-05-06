import { connect, flushEvents } from "./mockdom.js";
import * as I from "./i.js";
import test from "./test.js";
import * as ROP from "./rop.js";

const { assert, eq, eqAt } = test;
const use = I.use;

//----------------------------------------------------------------
// Utilities
//----------------------------------------------------------------

// Call fn() and transform pending (and optionally other) errors to ordinary
// values to make assertions easier.  catchAll => catch non-Pending errors.
//
const cleanError = (fn, catchAll) => {
    try {
        return use(fn());
    } catch (e) {
        const pend = I.checkPending(e);
        if (pend) {
            return ["PENDING", pend];
        } else if (catchAll) {
            return ["ERROR", I.rootCause(e)];
        }
        throw e;
    }
};

// Construct object for evaluation of fn() within a cell update, cleaning
// error responses, flushing events and accumulating results until quiescent.
//
const testCell = fn => {
    let results = [];
    // use inner cell to intern ["PENDING", ...] values
    const inner = I.cell(_ => cleanError(fn, self.catchAll));
    const self = I.cell(_ => results.push(use(inner)));
    self.catchAll = false;

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

// test Table
{
    const tbl = new ROP.Table();

    // add elements to grow table
    eq(0, tbl.alloc("A"));
    eq(1, tbl.alloc("B"));
    eq(2, tbl.alloc("C"));
    eq(["A", "B", "C"], [...tbl]);
    eq(3, tbl.size);

    // remove elements in non-LIFO order
    tbl.free(1);
    tbl.free(2);
    eq(["A", 3, 1], [...tbl]);
    eq(2, tbl.next);
    eq(1, tbl.size);

    // add without growing length
    eq(2, tbl.alloc("D"));
    eq(["A", 3, "D"], [...tbl]);
    eq(1, tbl.next);
    eq(2, tbl.size);
}

// test ObjTable
{
    const otbl = new ROP.ObjTable();
    let oa = {a:1};

    // register new object
    eq(0, otbl.reg(oa));
    assert(oa === otbl[0]);
    eq(1, otbl.counts[0]);

    // register object again => refcount 2
    eq(0, otbl.reg(oa));
    eq(2, otbl.counts[0]);
    eq(1, otbl.counts.size);

    // decrease refcount
    otbl.dereg(0); // oa
    assert(oa === otbl[0]);
    eq(1, otbl.counts.size);

    // decrease refcount to zero
    otbl.dereg(0); // oa
    eq(0, otbl.counts.size);
    assert(undefined === otbl[0]);
}

// test encoding & decoding
{
    // values
    const f1 = x => x;
    f1.oid = 1;
    const fm1 = x => x82;
    fm1.oid = -1;
    const t3 = I.lazy(_ => 2);
    t3.oid = 3;

    eq('{".abc":"..def","x":"y","a":[".F1",".F-1",".T3"]}',
       ROP.makeEncoder(o => o.oid)({".abc":".def",x:"y",a: [f1,fm1,t3]}));

    eq({".abc":".def",x:"y",a: [["F",1], ["F", -1], ["T", 3]]},
       ROP.makeDecoder((...a) => a)(
           '{".abc":"..def","x":"y","a":[".F1",".F-1",".T3"]}'));

    // errors
    let roundTrip = e =>
        ROP.decodeError(JSON.parse(JSON.stringify(ROP.encodeError(e))));

    eq("foo", roundTrip("foo"));
    eq([1,2], roundTrip([1,2]));
    eq({a:1}, roundTrip({a:1}));
    const e1 = new Error("msg", {cause: "text"});
    eq(e1, roundTrip(e1));
    const e2= new Error("rethrow", {cause: e1});
    eq(e2, roundTrip(e2));

    eq(I.rootCause(e2), I.rootCause(roundTrip(e2)));
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

const serverX = I.state();
const serverBoot = {
    add: (x, y) => use(x) + use(y),
    X: serverX,
    readX: () => use(serverX),
    echo: x => x,
    apply: (fn, ...args) => fn(...args),
};

const sa = new ROP.Agent(wsServer, serverBoot, {});
const ca = new ROP.Agent(wsClient, {}, serverBoot);
connect(wsServer, wsClient);
flushEvents();

const SOC = sa.objects.counts.size;

{
    // ASSERT: local & remote primordial objects populated
    eq(5, sa.objects.counts.size);
    eq(0, ca.objects.counts.size);
    assert(ca.remotes.add instanceof Function);

    // ASSERT: simple function calls work
    let tc = testCell(_ => ca.remotes.add(1, 2));
    tc.expectNew(["PENDING", "ROP observe"], 3);
    eq(1, ca.observers.size);
    tc.stop();
    eq(0, ca.observers.size);

    // ASSERT: remote function dependency changes are propagated
    serverX.set("a");
    tc = testCell(_ => ca.remotes.readX());
    tc.catchAll = true;
    tc.expectNew(["PENDING", "ROP observe"], "a");
    eq(1, ca.observers.size);
    eq(1, serverX.outputs.size);
    serverX.set(7);
    tc.expectNew(7);

    // ASSERT: remote function pending state is observed
    serverX.setError(new I.Pending("stalled"));
    tc.expectNew(["PENDING", "stalled"]);

    // ASSERT: other errors propagate to client side (message only)
    serverX.setError("broken");
    sa.silenceErrors = true;
    tc.expectNew(["ERROR", "broken"]);
    sa.silenceErrors = false;
    tc.stop();
    eq(0, ca.observers.size);

    // ASSERT: simple remote thunk use works
    assert(I.isThunk(ca.remotes.X));
    serverX.set("abc");
    tc = testCell(_ => use(ca.remotes.X));
    tc.expectNew(["PENDING", "ROP observe"], "abc");

    // ASSERT: observation is closed and resources are cleaned up
    serverX.set("DONE");
    tc.stop();
    eq(0, serverX.outputs.size);
    eq(0, ca.observers.size);
    eq(null, sa.updaters[0]);
    eq(SOC, sa.objects.counts.size);

    // ASSERT: New client should see no "leftover" state in slot
    serverX.set("NEW");
    tc = testCell(_ => ca.remotes.readX());
    tc.expectNew(["PENDING", "ROP observe"], "NEW");
    tc.stop();
}

// test: marshaling functions and thunks
{
    serverX.set("123");
    const localVar = I.state("abc");
    const localGet = _ => use(localVar);
    const R = ca.remotes;

    // ASSERT: functions/thunks local/remote survive transit:
    //  * local objects retain their identity
    //  * remote refs retain their identity (not strictly demanded by
    //    the protocol, but provided by rop.js)

    let tc = testCell(_ =>
        R.echo([localVar, localGet, R.X, R.readX]));
    let out = tc.getNew();
    eq(2, out.length);
    eq(["PENDING", "ROP observe"], out[0]);
    let [o1, o2, o3, o4] = out[1];
    assert(o1 === localVar)
    assert(o2 === localGet);
    assert(o3 === R.X);
    assert(o4 === R.readX);
    tc.stop();

    // ASSERT: function can directly return a thunk
    tc = testCell(_ => {
        let x = R.echo(R.X);
        assert(I.isThunk(x));
        assert(x === R.X);
        return x;
    });
    // cell results are use'd, so we don't see the thunk outside testCell
    tc.expect("123");
    tc.stop();

    // ASSERT: arg recipients can use thunks (local and remote)
    tc = testCell(_ =>
        R.add(localVar, R.X));
    tc.expectNew(["PENDING", "ROP observe"],
                 "abc123");
    tc.stop();

    // ASSERT: arg recipients can call functions (local and remote)
    serverX.set(2);
    let add1 = x => use(x) + 1;
    tc = testCell(_ =>
        R.apply(add1, R.X));
    tc.expect(3);

    // ASSERT: no intervening pending result on state change
    serverX.set(4);
    tc.expectNew(5);

    // ASSERT: observation is closed and resources are freed
    tc.stop();
    eq(0, ca.objects.counts.size);
    eq(SOC, sa.objects.counts.size);
}
