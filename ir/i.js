// i.js: See i.md

import {intern} from "./intern.js";

const assert = (cond) => {
    if (!cond) {
        throw new Error("Assertion failed");
    }
};

const cache = (map, key, fn) => {
    let v;
    return map.has(key) ? map.get(key) : (v = fn(), map.set(key, v), v);
};

let log = console.log.bind(console);

const setLogger = (f) => {
    const old = log;
    log = f;
    return old;
};

//------------------------------------------------------------------------
// Durable functions
//------------------------------------------------------------------------

// TBO: caching can (should?) be per-cell
const bakeRoot = new Map();
const ebakeRoot = new Map();

const memofn = (fnx, caps, isEmpty) => {
    let map = isEmpty ? ebakeRoot : bakeRoot;
    caps = intern(caps);
    map = cache(map, fnx, () => new Map());
    if (map.has(caps)) {
        return map.get(caps);
    }
    const fn = isEmpty ? _ => fnx(...caps) : fnx(...caps);
    assert(fn instanceof Function);
    fn.isDurable = true;
    fn.fnxName = fnx.name;
    fn.caps = caps;
    map.set(caps, fn);
    return fn;
};

const bake = (fnx, ...caps) => memofn(fnx, caps, false);
const ebake = (efnx, ...caps) => memofn(efnx, caps, true);

//------------------------------------------------------------------------
// Thunk & LazyThunk
//------------------------------------------------------------------------

class Thunk {
}

class LazyThunk extends Thunk {
    constructor(f) {
        super();
        this.f = f;
    }

    use() {
        return this.f.call(null);
    }
}

const isThunk = (value) => value instanceof Thunk;

// Force evaluation of a value.
//
const use = (value) => {
    while (value instanceof Thunk) {
        value = value.use();
    }
    return value;
};

const lazyRoot = new Map();

// Create a lazy expression thunk
//
const lazy = f =>
      f.isDurable
      ? cache(lazyRoot, f, _ => new LazyThunk(f))
      : new LazyThunk(f);

const defer = fx =>
      (...caps) => lazy(ebake(fx, ...caps));

// Apply lazily to a thunk, immediately otherwise.
//
const lazyApply = (f, v) =>
      isThunk(v) ? lazy(_ => f(use(v))) : f(v);

const deferApplyX = (f, v) => f(use(v));
const deferApply = f => v =>
      isThunk(v) ? defer(deferApplyX)(f, v) : f(v);

//----------------------------------------------------------------
// Exceptions
//----------------------------------------------------------------

// Return [true, RESULT] or [false, ERROR]
//
const tryUse = (value) => {
    try {
        return [true, use(value)];
    } catch (e) {
        return [false, e];
    }
};

const rootCause = (e) => {
    while (e instanceof Error && e.cause) {
        e = e.cause;
    }
    return e;
};

//------------------------------------------------------------------------
// Cell
//------------------------------------------------------------------------
//
// A `Cell` acts as a node in a dependency graph.  Cells may have inputs
// (cells they have used) and outputs (cells that use them).  "Function
// cells" have inputs and outputs.  "State cells" have only outputs.
// "Root cells" have only inputs.
//
// All cells implement implement the "used cell" interface:
//    update()
//    use()
//    unuse()
//
// Cells that depend on other cells implement the "using cell" interface:
//    setDirty()
//    addUsed(cell, result)
//
// Dependencies are added by: this.use() -> currentCell.addUsed()
//
// Dependencies are removed by: this.update() -> input.unuse()
//
// isDirty => result may have changed; outputs have been notified
// !isDirty => result is valid; any change should notify outputs
//
// TBO: Cells marked as "eager" skip dirtying their outputs and instead add
//    themselves to a root.dirtyEagers list, which are updated without
//    ordering concerns at the start of the next update.  If they change on
//    update, they dirty their outputs.  This repeats until no more eager
//    cells, then ordinary update proceeds.
//

class Cell extends Thunk {
    constructor() {
        super();
        this.result = null;
        this.isDirty = false;
        this.outputs = new Set();
    }

    setDirty() {
        if (!this.isDirty) {
            this.isDirty = true;
            for (const p of this.outputs) {
                p.setDirty();
            }
        }
    }

    // Called by a using cell no longer using this
    unuse(o) {
        this.outputs.delete(o);
        if (this.outputs.size == 0) {
            this.drop();
        }
    }

    drop() {}

    use() {
        const result = this.update();
        this.outputs.add(currentCell);
        currentCell.addUsed(this, result);
        const [succ, value] = result;
        if (succ) {
            return value;
        }
        // Generate stack trace in root context even for Pending; otherwise,
        // use during module loading (e.g. tests) is fatal and mysterious.
        throw value instanceof Pending && currentCell != globalRootCell
            ? value
            : new Error("used error", {cause: value});
    }
}

//------------------------------------------------------------------------
// StateCell
//------------------------------------------------------------------------

class StateCell extends Cell {
    constructor(initialResult) {
        super();
        this.setResult(initialResult);
    }

    setResult(result) {
        result = intern(result);
        if (result !== this.result) {
            this.result = result;
            this.setDirty();
        }
    }

    set(value) {
        this.setResult([true, value]);
    }

    setError(error) {
        this.setResult([false, error]);
    }

    // called by imperative code; does not track dependency
    peek() {
        const [succ, value] = this.result;
        assert(succ);
        return value;
    }

    update() {
        this.isDirty = false;
        return this.result;
    }
}

const state = (value, error) =>
      new StateCell(error == null
                    ? [true, value]
                    : [false, error]);

//------------------------------------------------------------------------
// FunCell
//------------------------------------------------------------------------
//
// Cell lifetime vs. liveness
//
// A cell may be constructed and used in different cells.  It starts as only
// a potential node in the dependency graph; it becomes live (in the graph)
// when it is used.  When removed from the graph, it returns to being a
// potential node, and it could be activated again.  A live cell will have
// one or more outputs (cells that use it), a result, and a known set of
// inputs.

// currentCell holds the cell currently being evaluated.  Initialized below.
let globalRootCell;
let currentCell;

class FunCell extends Cell {
    constructor(f) {
        super();
        this.f = f;
        this.inputs = null;
        this.cleanups = null;
    }

    // Register a dependency of ours -- called during this.update()
    //
    addUsed(input, value) {
        if (this.inputs == null) {
            this.inputs = new Map();
        }
        this.inputs.set(input, value);
    }

    // Call all registered `onDrop` functions.  This is called when the
    // current result is being discarded.
    //
    cleanup() {
        if (this.cleanups) {
            // Process cleanups in LIFO order
            for (const f of this.cleanups.reverse()) {
                f();
            }
            this.cleanups = null;
        }
    }

    // Register a function to be called after the cell is discarded or before it
    // is re-evaluated.
    //
    onDrop(cbk) {
        if (!this.cleanups) {
            this.cleanups = [];
        }
        this.cleanups.push(cbk);
    }

    // Discard result, call onDrop handlers, detach from inputs.
    // Called when this is no longer "live".
    //
    drop() {
        this.cleanup();

        // detach from inputs
        if (this.inputs != null) {
            for (const [input, _] of this.inputs) {
                input.unuse(this);
            }
            this.inputs = null;
        }

        // All using cells are gone, but `this` may be held by a creating
        // (but not using) cell or it may be cached in `cellRoot`.  Mark as
        // not evaluated so any future `use` will revive it.
        this.result = null;
    }

    // See if result is up-to-date with inputs.
    //
    validate() {
        if (this.result == null) {
            // never computed (inputs don't matter)
            return false;
        }
        if (!this.isDirty) {
            return true;
        }
        if (this.inputs) {
            // Validate cells in the order they were first evaluated,
            // to avoid recalculating un-live cells.
            for (const [cell, oldResult] of this.inputs) {
                const currentResult = cell.update();
                if (oldResult != currentResult) {
                    return false;
                }
            }
        }
        // skip re-validation of inputs on later call
        this.isDirty = false;
        return true;
    }

    // Recalculate if necessary.
    //
    update() {
        if (this.validate()) {
            return this.result;
        }

        // Recalculate...

        this.cleanup();
        const oldInputs = this.inputs;
        this.inputs = null;
        this.isDirty = false;
        const usingCell = currentCell;
        let result;
        currentCell = this;
        try {
            result = [true, this.f.call(null)];
        } catch (e) {
            result = [false, e];
        }
        currentCell = usingCell;
        this.result = intern(result);

        if (oldInputs != null) {
            // Sanity check: no transition from some inputs to *none*
            assert(this.inputs);
            for (const [input, value] of oldInputs) {
                if (!this.inputs.has(input)) {
                    input.unuse(this);
                }
            }
        }

        // Sanity check: no invalidations during update or input.unuse
        assert(this.isDirty == false);
        return this.result;
    }

    // Remove cell from all its outputs; this triggers drop() indirectly.
    //
    deactivate() {
        for (const o of this.outputs) {
            o.inputs.delete(this);
            this.unuse(o);
        }
    }
}

//----------------------------------------------------------------
// RootCell
//----------------------------------------------------------------
//
// A RootCell has no outputs and is self-updating.
//

class RootCell extends FunCell {
    constructor() {
        super();
    }

    setDirty() {
        if (!this.isDirty) {
            this.isDirty = true;
            setTimeout(_ => this.update());
        }
    }

    // preserve inputs and update them; don't call onDrops
    update() {
        this.isDirty = false;
        if (this.inputs) {
            for (const [input, _] of this.inputs) {
                ifPending(input, _ => null);
            }
        }
    }
};

//----------------------------------------------------------------
// Cell APIs
//----------------------------------------------------------------

const cellRoot = new Map();

const cell = (f) =>
      (f.isDurable
       ? cache(cellRoot, f, _ => new FunCell(f))
       : new FunCell(f));

const wrap = (efnx) => (...caps) => cell(ebake(efnx, ...caps));

const memo = (efnx) => (...args) => use(cell(ebake(efnx, ...args)));

const onDrop = (f) => {
    assert(f instanceof Function);
    currentCell.onDrop(f);
};

// globalRootCell acts as output for cells evaluated outside of an udpate.
globalRootCell = new RootCell();
currentCell = globalRootCell;

// Return cell that is currently being evaluated (for debuging).
const getCurrentCell = _ => currentCell;

// Log an error description, including all errors in the cause chain.
//
// Also, elide stack entries that originate from this module.
//    Chrome:     at use (http://ORIGIN/i.js:139:13)
//    Safari: use@http://ORIGIN/i.js:139:20
//   Firefox: use@http://ORIGIN/i.js:139:13
//
const logError = (e, desc) => {
    if (desc) {
        log("*** " + desc + ":");
    }
    if (e.cause) {
        logError(e.cause);
    }
    let stack = e.stack;
    if (stack) {
        if (!stack.match("^Error: ")) {
            stack = (`Error: ${e.message}\n` + stack)
                .replace(/\n([^@:/\n]+)@([^\n]+)/g, "\n@$1 ($2)")
                .replace(/\n@/g, "\n    at ");
        }
        log(stack.replace(/\n[^\n]+\/i\.js:[^\n]+/g, ''));
    } else {
        log(e);
    }
};

//------------------------------------------------------------------------
// Streams
//------------------------------------------------------------------------

class StreamPos {
    // Destructively (!) add a new event, returning a new tail.
    pushEvent(evt) {
        assert(this.event == undefined);
        this.event = evt;
        return (this.next = new StreamPos());
    }

    forEachSince(prev, fn) {
        for (let o = prev; o != null && o.event && o !== this; o = o.next) {
            fn(o.event);
        }
    }
}

// Create a writable stream (thunk & cell).
//
// stream.emit(value) appends values to the stream.  It is a function and
// does not need to be invoked as a method.
//
const newStream = () => {
    let tail = new StreamPos();
    const stream = state(tail);

    stream.emit = (value) => {
        tail = tail.pushEvent(value);
        stream.set(tail);
    };
    return stream;
};

// Return a cell whose value is `f` applied to sequential values in `xs`.
// If the result type is StreamPos, this cell will itself be a stream.
//
// fold: (f, initialResult) -> Stream -> resultCell
//    f: (prevResult, x) -> newResult
//
const fold = (f, z) => xs => {
    let pos = null;
    const xfn = () => {
        const oldPos = pos;
        pos = use(xs);
        // TODO: errors?
        let [succ, out] = currentCell.result || [true, z];
        pos.forEachSince(oldPos, x => {
            out = f(out, x);
        });
        return out;
    };

    return new FunCell(xfn);
};

// Transform a stream.
//
// flatMap: f -> Stream -> Stream
// f: (streamPos, event) -> streamPos
//    Appends zero or more events to the output stream, given
//    an event from the input stream.
//
const flatMap = (f) => fold(f, new StreamPos());

// Return a stream of selected elements from another stream.
//
// filter: f -> Stream -> Stream
//      f: (streamPos, value) -> streamPos
const filter = (f) => flatMap((s, x) => f(x) ? s.pushEvent(x) : s);

// Return a stream of transformed elements from another stream.
//
// map: f -> Stream -> Stream
//   f: value -> value
const map = (f) => flatMap((s, x) => s.pushEvent(f(x)));

const stream = {
    newStream,
    fold,
    flatMap,
    filter,
    map,
};

//------------------------------------------------------------------------
// Pending errors (experimental)
//------------------------------------------------------------------------

// A Pending object is thrown to indicate that an failure is temporary.
// It can be triggered in these ways:
//
//  A) throw new Pending("connecting");
//  B) throw new Error("pending", { cause: Pending("connecting") });
//  C) stateCell.setError(Pending("connecting"));
//
// (B) will generate a stack trace for the `throw` expression, while (A)
// will not.  (C) will generate an error (and stack trace) when the state
// cell is used.
//
class Pending {
    constructor(value) {
        this.value = value;
    }
}

// Recover `value` if error resulted from `throw new Pending(value)`
//
const checkPending = error => {
    const cause = rootCause(error);
    if (cause instanceof Pending) {
        return cause.value;
    }
};

// Return `value` if it does not throw an error, or then(p) if it threw a
// pending result.
//
const ifPending = (value, then) => {
    try {
        return use(value);
    } catch (error) {
        const cause = rootCause(error);
        if (cause instanceof Pending) {
            return then(cause.value);
        }
        throw error;
    }
};

//------------------------------------------------------------------------
// Diagnostics: logCell
//------------------------------------------------------------------------

const objIDs = new Map();

const getID = v => cache(objIDs, v, () => objIDs.size);

const cellName = (cell) => {
    const name =
          cell.name ? cell.name :  // may be set for debugging
          cell instanceof RootCell ? "root" :
          cell instanceof StateCell ? "state" :
          cell.key ? "wrap" :
          "cell";
    return name + String(getID(cell));
};

const objName = (obj) =>
      Object.getPrototypeOf(obj).constructor.name
      + " " + (obj.name ?? "#" + getID(obj));

const valueTextAt = (depth, v, r) =>
      depth > 9 ? "..." :
      v instanceof Object ? (
          (v instanceof Cell ? cellName(v) :
           v instanceof Pending ? `<Pending ${r(v.value)}>` :
           v instanceof Function ? (v.name
                                    ? `${v.name}#${getID(v)}`
                                    : `<Fn#${getID(v)}>`) :
           v instanceof Error ? `<Error ${r(v.cause ?? v.message)}>` :
           v instanceof Array ? (depth == 0 ? `[${v.map(r)}]` : `[...]`) :
           `<${objName(v)}>`)) :
      typeof v == "string" ? '"' + v.replace(/\n/g, "\\n") + '"' :
      String(v);

const resultText = ([succ, v]) => {
    const rr = depth => v => valueTextAt(depth, v, rr(depth+1));
    const text = rr(0)(v);
    return succ ? text : `<Caught ${text}>`;
};

const showTree = (start, getInputs, getText, logger) => {
    const recur = (node, prefix1, prefix) => {
        getText(node).forEach((line, num) => {
            logger((num==0 ? prefix1 : prefix) + line);
        });
        const a = [...getInputs(node)];
        a.forEach( (input, ndx) => {
            recur(input,
                  prefix + " + ",
                  prefix + (ndx + 1 == a.length ? "   " : " | "));
        });
    };
    recur(start, "* ", "  ");
};

const logCell = (root, options) => {
    root ??= (root === null ? globalRootCell : currentCell);
    options ??= {};

    const getCellText = (cell) => {
        const name = cellName(cell);
        const value = resultText(cell.result);
        const dirty = cell.isDirty ? "! " : "";
        const out = [`${name}: ${dirty}${value}`];
        const f = cell.f;
        if (!options.brief && (f.fnxName || f.name)) {
            const fname = f.fnxName || f.name;
            const fargs = f.caps ? f.caps.map(valueText).join(",") : "()";
            out.push(`  = ${fname}(${fargs})`);
        }
        if (cell.cleanups) {
            out.push(`  cleanups: ${cell.cleanups.length}`);
        }
        return out;
    };

    showTree(root,
             c => (c.inputs ?? []).keys(),
             getCellText,
             options.log || log);
};

//------------------------------------------------------------------------
// Exports
//------------------------------------------------------------------------

export {
    bake,
    ebake,
    isThunk,
    use,
    lazy,
    defer,
    lazyApply,
    deferApply,
    tryUse,
    rootCause,
    state,
    cell,
    wrap,
    memo,
    onDrop,
    stream,

    // experimental
    Pending,
    checkPending,
    ifPending,

    // debugging, testing
    logCell,
    resultText,
    setLogger,
    logError,
    getCurrentCell,
};
