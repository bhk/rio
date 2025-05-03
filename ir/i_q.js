import test from "./test.js";
import {flushEvents} from "./mockdom.js";
let {assert, eq} = test;

import {
    bake, ebake, isThunk, use, lazy, defer, lazyApply, deferApply,
    tryUse, rootCause, Pending, checkPending, usePending,
    state, cell, wrap, memo, onDrop, stream,
    getCurrentCell, setLogger
} from "./i.js";

// bake, ebake
{
    // ASSERT: bake() result is functioning, indempotent, and stamped
    let fnx = (m, b) => (x) => m*x + b;
    let fn = bake(fnx, 2, 3);
    eq(fn(5), 13);
    assert(fn === bake(fnx, 2, 3));
    assert(fn.isDurable);
    eq("fnx(2,3)", fn.fnxName + "(" + fn.caps.join(",") + ")");

    // ASSERT: ebake() result is functioning, indempotent, and stamped
    let efnx = (x, m, b) => m*x + b;
    let efn = ebake(efnx, 2, 3, 5);
    eq(efn(), 11);
    assert(efn === ebake(efnx, 2, 3, 5));
    assert(efn.isDurable);
    eq("efnx(2,3,5)", efn.fnxName + "(" + efn.caps.join(",") + ")");
}

// isThunk, use, lazy, defer, lazyApply, deferApply
{
    let fa = () => 1;
    const a1 = lazy(fa);
    const a2 = lazy(fa);
    eq(false, a1 === a2);
    assert(isThunk(a1));
    eq(use(a1), 1);

    let efx = (a) => a;
    let efb = ebake(efx, 2);
    const b1 = lazy(efb);
    const b2 = lazy(efb);
    assert(b1 === b2);
    eq(use(b1), 2);

    let d = defer(efx)(2);
    eq(d, b1);

    const ff = a => a*2;
    eq(ff, use(ff));       // use of non-thunk

    eq(21, lazyApply(x => x*3, 7));
    let dx3 = lazyApply(x => x*3, d);
    assert(isThunk(dx3));
    eq(6, use(dx3));
    eq(6, use(deferApply(x => x*3)(d)));
}

// tryUse, rootCause, Pending, checkPending, usePending
{
    let succ, v;

    // ASSERT: tryUse() catches error
    eq([true, 2], tryUse(lazy(_ => 2)));
    [succ, v] = tryUse(lazy(_ => { throw "YOW"; }));
    eq(succ, false);
    eq(rootCause(v), "YOW");

    // ASSERT: checkPending(e) recovers value from thrown Pending object
    eq(2, checkPending(new Pending(2)));
    eq(1, checkPending(new Error("foo", {cause: new Pending(1)})));
    eq(undefined, checkPending(new Error("foo")));

    // ASSERT: checkPending returns `undefined` for non-pending errors/causes
    eq(undefined, checkPending("hi"));
    eq(undefined, checkPending(null));

    // ASSERT: usePending catches Pending() errors
    [succ, v] = usePending(lazy(_ => { throw new Pending("P");}));
    eq([succ, v], [false, "P"]);

    // ASSERT: usePending re-throws non-Pending errors
    try {
        [succ, v] = usePending(lazy(_ => { throw "ERR"; }));
    } catch (e) {
        [succ, v] = ["caught", rootCause(e)];
    }
    eq([succ, v], ["caught", "ERR"]);
}

// Pattern for testing reactivity
//
// When we want a test that constructs one or more cells and repeats
// evaluations after modifying inputs, we could just call use(cell) to
// evaluate them, but that would pollute the root cell's input set, and not
// clean up the cell and its dependencies (calling onDrop-registered
// handlers).
//
// To do this hygenically, avoiding calling use() in the root context:
//
//  - Create a base cell whose function calls the other cell(s)
//  - Call base.update() to evaluate.  Note that update() does not rethrow
//    cell errors; use cellError() to check for errors.
//  - Call base.drop() when done
//
// The base cell might need to be specially constructed as an "alternate
// root" when/if we implement some update optimizations.
//

// state, cell, wrap, memo, onDrop -- and test IR update algorithm
{
    let events = [];
    let log = str => events.push(str);

    let out;

    // ASSERT: cell(durable function) => durable cell (cell & wrap)
    let dcx = (a) => {
        log(a);
        onDrop(_ => log(`drop(${a})`));
        return a;
    };
    let dc = cell(ebake(dcx, "DC"));
    assert(dc === cell(ebake(dcx, "DC")));
    // ASSERT: wrap(F)(C) == cell(ebake(F,C))
    assert(dc === wrap(dcx)("DC"));

    // Test update algorithm

    let sx = state(1);
    let sy = state(2);
    let c1 = cell(_ => (log(1), use(sx) + 10));
    let c2 = cell(_ => (log(2), use(sx) + (6 & use(sy))));
    let c3 = cell(_ => (log(3), use(c1) + use(c2)));
    let c4 = cell(_ => {
        log(4);
        out=use(c3);
        eq("DC", use(cell(ebake(dcx, "DC"))));
        return null;  // prevent update of base
    });

    let trunk = cell(_ => (log("T"), use(c4)));

    let update = _ => {
        events = [];
        eq(null, trunk.update());
        log(out);
        return events;
    };

    // ASSERT: Initial evaluation same as non-incremental
    eq(update(), ["T", 4, 3, 1, 2, "DC", 14]);

    // ASSERT: No changes => no recalcs
    eq(update(), [14]);

    // ASSERT: Dirty but not invalid => no recalcs
    sx.set(9);
    sx.set(1);
    eq(update(), [14]);

    // ASSERT: only invalid cells update (no propagation from c2 down)
    sy.set(3);
    eq(update(), [2, 14]);

    // ASSERT: cell(ebake()...) durable ("DC" not re-created when c4 recalced)
    sy.set(4);
    eq(update(), [2, 3, 4, 16]);

    // ASSERT: c1 eval'ed before c3 (both invalid)
    // ASSERT: c3 recalced only once (though 2 inputs changed)
    sx.set(3);
    eq(update(), [1, 3, 2, 4, 20]);

    // ASSERT: onDrop() callbacks fire when cell is no longer live
    events = [];
    trunk.drop();
    eq(events, ["drop(DC)"]);

    // ASSERT: memo(dcx)("dc") uses same cell as cell(ebake(dcx, "dc"))
    let base = cell(_ => memo(dcx)("DC"));
    eq("DC", base.update());
    eq(1, base.inputs.size);
    base.drop();
}

// stream
{
    let s = stream.newStream();
    let smap = stream.map(n => n*2)(s);
    let sfilt = stream.filter(n => n <= 4)(smap);
    let sfold = stream.fold((v, n) => v + ":" + n, "")(sfilt);
    eq(sfold.update(), "");
    s.emit(1);
    s.emit(3);
    s.emit(2);
    eq(sfold.update(), ":2:4");

    sfold.drop();
}

// root error handling
{
    let st = state(0);
    use(st);

    let caught = false;
    let logOutput = "";
    st.setError(new Error("UNCAUGHT"));

    const oldlog = setLogger((msg) => { logOutput += msg });
    try {
        flushEvents();
    } catch (e) {
        caught = e;
    }
    setLogger(oldlog);

    // ASSERT: root cell auto-update does not catch errors, but logs them
    assert(caught);
    let root = getCurrentCell();
    eq(root.isDirty, false);
    assert(logOutput.match("Error"));
}
