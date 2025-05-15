import test from "./test.js";
import { flushEvents } from "./mockdom.js";
let { assert, eq } = test;

import {
    bake, ebake, isThunk, use, lazy, defer, lazyApply, deferApply,
    tryUse, rootCause, Pending, checkPending, ifPending,
    state, cell, wrap, memo, onDrop, stream, onceCell,
    getCurrentCell, setLogger
} from "./i.js";

// Pattern for testing reactivity
//
// When we want to test evalauation of one or more cells, we can call
// use(cell) in the root context, but this adds it to the root cell's input
// set, which will make it persist (by default) and continue to be updated.
// In some cases we want to ensure that all `onDrop` handlers are called.
//
//  * Create a "base" cell that consumes the other cells
//  * Evaluate it with use(base).
//  * Clean up with base.deactivate().
//
// The base cell might need to be specially constructed as an "alternate
// root" when/if we implement some update optimizations in the future.
//

// bake, ebake
{
    // ASSERT: bake() result is functioning, indempotent, and stamped
    const fnx = (m, b) => (x) => m*x + b;
    const fn = bake(fnx, 2, 3);
    eq(fn(5), 13);
    assert(fn === bake(fnx, 2, 3));
    assert(fn.isDurable);
    eq("fnx(2,3)", fn.fnxName + "(" + fn.caps.join(",") + ")");

    // ASSERT: ebake() result is functioning, indempotent, and stamped
    const efnx = (x, m, b) => m*x + b;
    const efn = ebake(efnx, 2, 3, 5);
    eq(efn(), 11);
    assert(efn === ebake(efnx, 2, 3, 5));
    assert(efn.isDurable);
    eq("efnx(2,3,5)", efn.fnxName + "(" + efn.caps.join(",") + ")");
}

// isThunk, use, lazy, defer, lazyApply, deferApply
{
    const fa = () => 1;
    const a1 = lazy(fa);
    const a2 = lazy(fa);
    eq(false, a1 === a2);
    assert(isThunk(a1));
    eq(use(a1), 1);

    const efx = (a) => a;
    const efb = ebake(efx, 2);
    const b1 = lazy(efb);
    const b2 = lazy(efb);
    assert(b1 === b2);
    eq(use(b1), 2);

    const d = defer(efx)(2);
    eq(d, b1);

    const ff = a => a*2;
    eq(ff, use(ff));       // use of non-thunk

    eq(21, lazyApply(x => x*3, 7));
    const dx3 = lazyApply(x => x*3, d);
    assert(isThunk(dx3));
    eq(6, use(dx3));
    eq(6, use(deferApply(x => x*3)(d)));
}

// state, cell, wrap, memo, onDrop -- and test IR update algorithm
{
    // ASSERT: cell(durable function) => durable cell (cell & wrap)
    const dcx = a => a + a;
    const dc = cell(ebake(dcx, "X"));
    assert(dc === cell(ebake(dcx, "X")));

    // ASSERT: wrap(F)(C) uses same cell as cell(ebake(F,C))
    const wfc = wrap(dcx)("X");
    assert(dc === wrap(dcx)("X"));

    // ASSERT: constant cells are not tracked
    const base1 = cell(_ => use(dc));
    eq("XX", use(base1));
    eq(null, base1.inputs);
    base1.deactivate();

    // Test update algorithm by tracking cell recalculations
    let events = [];
    const log = str => events.push(str);

    const sx = state(1);
    const sy = state(2);
    const c1 = cell(_ => (log(1), use(sx) + 10));
    const c2 = cell(_ => (log(2), use(sx) + (6 & use(sy))));
    const c3 = cell(_ => (log(3), use(c1) + use(c2)));
    const c4x = a => (log(4), onDrop(_ => log(-4)), a + a);
    const base = cell(_ => {
        log(5);
        const v = use(c3);
        if (v < 20) {
            eq("AA", use(cell(ebake(c4x, "A"))));
        }
        return v;
    });

    const update = _ => {
        events = [];
        log("out=" + use(base));
        return events;
    };

    // ASSERT: Initial evaluation same as non-incremental (all cells)
    eq(update(), [5, 3, 1, 2, 4, "out=14"]);

    // ASSERT: No changes => no recalcs
    eq(update(), ["out=14"]);

    // ASSERT: Dirty but not invalid => no recalcs
    sx.set(9);
    sx.set(1);
    eq(update(), ["out=14"]);

    // ASSERT: only invalid cells update (no propagation from c2 down)
    sy.set(3);
    eq(update(), [2, "out=14"]);

    // ASSERT: cell(ebake()...) durable ("DC" not re-created when c4 recalced)
    sy.set(4);
    eq(update(), [2, 3, 5, "out=16"]);

    // ASSERT: c1 eval'ed before c3 (both invalid)
    // ASSERT: c3 recalced only once (though 2 inputs changed)
    // ASSERT: onDrop() callbacks fire when cell is no longer live
    sx.set(3);
    eq(update(), [1, 3, 2, 5, -4, "out=20"]);

    // ASSERT: memoized cell comes back to life
    sx.set(1);
    eq(update(), [1, 3, 2, 5, 4, "out=16"]);

    events = [];
    base.deactivate();
    eq(events, [-4]);
}


// onceCell
{
    // ASSERT: reflects pending & remains non-constant
    const st = state(null, new Pending("init"));
    let oc = onceCell(_ => use(st));
    eq("init", ifPending(oc, e => e));
    eq(false, oc.isConstant());
    st.setError(new Pending("new"));
    eq("new", ifPending(oc, e => e));
    eq(false, oc.isConstant());

    // ASSERT: transitions to constant on succes
    st.set(0);
    eq(0, ifPending(oc, e => e));
    eq(true, oc.isConstant());

    // ASSERT: constant cell does not recalculate
    st.set(1);
    eq(0, ifPending(oc, e => e));

    // ASSERT: constant cell removed from root cell's inputs
    flushEvents();
    eq(0, oc.outputs.size);

    // ASSERT: transitions to constant on error
    oc = onceCell(_ => use(st));
    st.setError("E");
    const [succ, e] = tryUse(oc);
    eq(false, succ);
    eq("E", rootCause(e));
    eq(true, oc.isConstant());
    flushEvents();
    eq(0, oc.outputs.size);
}

// stream
{
    const s = stream.newStream();
    const smap = stream.map(n => n*2)(s);
    const sfilt = stream.filter(n => n <= 4)(smap);
    const sfold = stream.fold((v, n) => v + ":" + n, "")(sfilt);
    eq(use(sfold), "");
    s.emit(1);
    s.emit(3);
    s.emit(2);
    eq(use(sfold), ":2:4");

    sfold.deactivate();
}

// tryUse, rootCause, Pending, checkPending, ifPending
{
    const catchRethrown = error => {
        const c0 = state(null, error);
        const c1 = cell(_ => use(c0));
        const c2 = cell(_ => use(c1));
        const errorOut = tryUse(c2)[1];
        c2.deactivate();
        return errorOut;
    };
    let succ, v;

    // ASSERT: tryUse() catches error
    eq([true, 2], tryUse(lazy(_ => 2)));
    [succ, v] = tryUse(lazy(_ => { throw "YOW"; }));
    eq(succ, false);
    eq(rootCause(v), "YOW");

    // ASSERT: checkPending(e) recovers value from thrown Pending objects.
    eq(undefined, checkPending(new Error("foo")));
    eq(undefined, checkPending("other"));
    eq(1, checkPending(new Pending(1)));
    eq(2, checkPending(new Error("foo", {cause: new Pending(2)})));

    // ASSERT: checkPending() works with rethrown pending errors
    eq(99, checkPending(catchRethrown(new Pending(99))));
    eq(99, checkPending(catchRethrown(
        new Error("state", {cause: new Pending(99)}))));
    // ASSERT: Pending() rethrown as Error object only in root context
    eq(new Pending(99), catchRethrown(new Pending(99)).cause);

    // ASSERT: checkPending returns `undefined` for non-pending errors/causes
    eq(undefined, checkPending("hi"));
    eq(undefined, checkPending(null));

    // ASSERT: ifPending catches Pending() errors
    eq("P", ifPending(lazy(_ => { throw new Pending("P");}), p => p));

    // ASSERT: ifPending re-throws non-Pending errors
    try {
        v = ifPending(lazy(_ => { throw "ERR"; }), false);
    } catch (e) {
        v = ["caught", rootCause(e)];
    }
    eq(v, ["caught", "ERR"]);
}

// root error handling
if (false) {
    const st = state(0);
    use(st);

    const caught = false;
    const logOutput = "";
    st.setError(new Error("UNCAUGHT"));

    const oldlog = setLogger((msg) => { logOutput += msg });
    try {
        flushEvents();
    } catch (e) {
        caught = e;
    }
    setLogger(oldlog);

    // ASSERT: root cell auto-update does not catch errors
    assert(caught);
    const root = getCurrentCell();
    eq(root.isDirty, false);
    // Not logging errors now... let's see how that goes.
    // assert(logOutput.match("Error"));
}
