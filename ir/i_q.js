import test from "./test.js";
import {flushEvents} from "./mockdom.js";
let {eq, assert} = test;

import {
    defer, use, isThunk, wrap, useError, usePending, checkPending, Pending,
    rootCause, newState, newCell, onDrop, activate, stream,
    getCurrentCell, setLogger
} from "./i.js";

let root = getCurrentCell();
let events = "";

// defer, use, isThunk

eq(2, use(2));
eq(null, use(null));
eq({}, use({}));
const ff = a => a*2;
eq(ff, use(ff));

eq(true, isThunk(defer(_ => 2)));
eq(2, use(defer(_ => 2)));
eq(ff, use(defer(_ => ff)));

// test Cell, newState, newCell, onDrop

let rootInputsSize = (root.inputs ? root.inputs.size : 0);
{
    //  a <- b c d
    //  b <- c x
    //  c <- x
    //  d <- y

    const y = newState(1);
    const x = newState(2);
    const d = newCell(() => {
        events += "d";
        return use(y);
    });
    const c = newCell(() => {
        events += "c";
        return use(x)**2;
    });
    const b = newCell(() => {
        events += "b";
        onDrop(() => events += "B");
        return use(c) + Math.abs(use(x));
    });
    const a = newCell(() => {
        events += "a";
        return use(b) + use(c) + use(d);
    });

    // ASSERT: initial use => one recalc of each function cell
    eq(events, "");
    eq(use(a), 11);
    eq(events, "abcd");

    // ASSERT: second use, no changes => no more recalcs
    eq(use(a), 11);
    eq(events, "abcd");

    // ASSERT: optimal recalcs despite diamond (a <- b&c <- x)
    // ASSERT: onDrop() fires prior to recalculation
    events = "";
    x.set(1);
    eq(use(a), 4);
    eq(events, "cBba");

    // ASSERT: dirty but not invalid dependencies
    events = "";
    x.set(-1);
    eq(use(a), 4);
    eq(events, "cBb");

    // ASSERT: used cell is activated
    events = "";
    x.set(0);
    eq(a.isDirty, true);
    flushEvents();
    eq(a.isDirty, false);
    eq(events, "cBba");
    eq(a.result, 1);

    // ASSERT: onDrop() fires when cell is orphaned
    events = "";
    a.deactivate();
    events = "B";

    eq(root.inputs.size, rootInputsSize);
}

// wrap

{
    let f = (a, b) => a + b;
    let w = wrap(f);
    // ASSERT: matching invocations return same cell
    eq(w.cell(1,2), w.cell(1,2));
    // ASSERT: w(...) == use(w.cell(...)
    eq(w(1, 2), use(w.cell(1,2)))
    eq(w(1,2), 3);
    w.cell(1,2).deactivate();
    eq(root.inputs.size, rootInputsSize);
}

// activate

{
    let s = newState(0);
    let f = (a, b) => {
        let value = a + b + use(s);
        events += "(" + value + ")";
        return value;
    };

    // ASSERT: activate() synchronously updates
    events = "";
    let c1 = activate(f, 1, 2);
    eq(events, "(3)");

    // ASSERT: activate() is *not* memoized
    let c2 = activate(f, 1, 2);
    eq(events, "(3)(3)");
    assert(c1 != c2);
    c2.deactivate();

    // ASSERT: activate() returns activated cell
    events = "";
    s.set(1);
    eq(root.isDirty, true);
    flushEvents();
    eq(events, "(4)");
    eq(root.isDirty, false);

    c1.deactivate();
    eq(root.isDirty, false);
}

// test useError, usePending, Pending, rootCause, and exception handling
// TODO: state.setError

{
    // ASSERT: `throw` is caught at cell boundary
    // ASSERT: use() of cell in error state throws an Error()
    // ASSERT: useError(cell) returns the thrown error/object
    let st = newState("THROWN");
    let errCell = newCell(() => { throw use(st); });
    let cell = newCell(() => use(errCell));
    let [succ, v] = useError(cell);
    eq(succ, false);
    eq(rootCause(v), "THROWN");   // TODO: rootCause by default
    [succ, v] = useError(errCell);
    eq(succ, false);
    eq(rootCause(v), "THROWN");

    // ASSERT: usePending catches Pending() errors
    st.set(new Pending("st"));
    let [done, result] = usePending(cell);
    eq([done, result], [false, "st"]);

    // ASSERT: usePending re-throws non-Pending errors
    {
        st.set("XXX");
        const pcell = newCell(() => use(cell));
        let [succ, value] = useError(pcell);
        eq(succ, false);
        eq(value, "XXX");
        pcell.deactivate();
    }

    // ASSERT: root cell auto-update does not catch errors, but does log them
    st.set(new Pending("connecting"));
    eq(root.isDirty, true);
    let caught = false;
    let logs = "";
    // capture
    const oldlog = setLogger((msg) => { logs += msg });
    try {
        flushEvents();
    } catch (e) {
        caught = e;
    }
    setLogger(oldlog);
    assert(caught);
    eq(root.isDirty, false);
    assert(logs.match("Error"));

    // ASSERT: checkPending(e) recovers value from thrown Pending object
    eq(checkPending(caught), "connecting");
    eq(1, checkPending(new Error("foo", {cause: new Pending(1)})));
    eq(2, checkPending(new Pending(2)));

    // ASSERT: checkPending returns `undefined` for non-pending errors/causes
    eq(undefined, checkPending("hi"));
    eq(undefined, checkPending(null));
}

// stream.*

{
    let s = stream.newStream();
    let smap = stream.map(n => n*2)(s);
    let sfilt = stream.filter(n => n <= 4)(smap);
    let sfold = stream.fold((v, n) => v + ":" + n, "")(sfilt);
    eq(use(sfold), "");
    s.emit(1);
    s.emit(3);
    s.emit(2);
    eq(use(sfold), ":2:4");

    sfold.deactivate();
}
