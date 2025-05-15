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
const lazy = f => {
    assert(typeof f == "function");
    return f.isDurable
        ? cache(lazyRoot, f, _ => new LazyThunk(f))
        : new LazyThunk(f);
};

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
// All cells implement the following:
//    use()
//    unuse()
//    update()
//    isConstant()
//
// Cells that depend on other cells implement the "using cell" interface:
//    dirty()
//    addUsed(cell, result)
//
// Dependencies are added by: this.use() -> currentCell.addUsed()
//
// Dependencies are removed by: this.update() -> input.unuse()
//
// Members;
//
//   isDirty => result may have changed & outputs have been notified;
//       (false => result is valid & any change should notify outputs.)
//   result = [succ, value] : succ==false => error was caught (value);
//            `null` when yet to be initialized/computed
//   outputs: cells that use this cell
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

    // Update and return current value, throwing if in error state, and make
    // this cell a dependency of the current cell.
    //
    use() {
        const result = this.update();
        if (!this.isConstant()) {
            this.outputs.add(currentCell);
            currentCell.addUsed(this, result);
        }
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

    // Remove output.  (Called by the output that no longer uses this.)
    //
    unuse(o) {
        this.outputs.delete(o);
        if (this.outputs.size == 0) {
            this.drop();
        }
    }

    // Return cell's (caught) result without making this a dependency.
    //
    update() {
        this.isDirty = false;
        return this.result;
    }

    // Discard result, call onDrop handlers, detach from inputs.
    // Called when this is no longer "live".
    //
    drop() {}

    // If a cell does not need to be tracked as a dependency, is is
    // considered a "constant" cell.  This will be the case for function
    // cells when they observe no other cells and register no cleanups.
    //
    isConstant() {
        return false;
    }

    // If this cell isn't dirty, mark it dirty and dirty its outputs.
    //
    dirty() {
        if (!this.isDirty) {
            this.isDirty = true;
            for (const p of this.outputs) {
                p.dirty();
            }
        }
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

    // Set the result.  If changed, mark dirty.
    //
    setResult(result) {
        result = intern(result);
        if (result !== this.result) {
            this.result = result;
            this.dirty();
        }
    }

    // Set the result to a non-error value.
    //
    set(value) {
        this.setResult([true, value]);
    }

    // Set the result to an error state.
    //
    setError(error) {
        this.setResult([false, error]);
    }

    // Return current value, as with use, but without tracking dependency.
    // (Called by imperative code.)
    //
    peek() {
        const [succ, value] = this.result;
        assert(succ);
        return value;
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

    // See Cell.drop().
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
                    // At this point, our current result is invalid, and
                    // may contain dangling remote object references.
                    return false;
                }
            }
        }
        // skip re-validation of inputs on later call
        this.isDirty = false;
        return true;
    }

    // Return result, recalculating if necessary.
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
            const newInputs = this.inputs || new Map();
            for (const [input, value] of oldInputs) {
                if (!newInputs.has(input)) {
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

    // true => no need to record this cell as a dependency
    isConstant() {
        return this.inputs == null && this.cleanups == null;
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
        super(null);
        this.f = this.recalc.bind(this);
    }

    dirty() {
        if (!this.isDirty) {
            this.isDirty = true;
            setTimeout(this.onUpdate.bind(this));
        }
    }

    onUpdate() {
        this.cleanups = null;   // we cannot recalc, so don't clean up
        this.oldInputs = this.inputs;
        this.update();
    }

    recalc() {
        for (const [input, _] of this.oldInputs) {
            try {
                use(input);
            } catch (e) {
                // do nothing for now
            }
        }
    }
};

//----------------------------------------------------------------
// Cell APIs
//----------------------------------------------------------------

const cellRoot = new Map();

const cell = (efn) =>
      (efn.isDurable
       ? cache(cellRoot, efn, _ => new FunCell(efn))
       : new FunCell(efn));

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
// pending result.  If `then` is not provided, silently ignore Pending.
//
const ifPending = (value, then) => {
    try {
        return use(value);
    } catch (error) {
        const cause = rootCause(error);
        if (cause instanceof Pending) {
            return then ? then(cause.value) : undefined;
        }
        throw error;
    }
};

// Create cell that becomes "constant" when `thunk` is not Pending.
// Initially, it may throw Pending errors.  Eventually, it will throw a
// non-Pending error or return a result, and then become "constant", which
// will remove it from the dependency graph.
//
const onceCell = efn => cell(_ => {
    let succ, value;
    try {
        [succ, value] = [true, use(efn())];
    } catch (e) {
        [succ, value] = [false, e];
    }
    if (succ || !checkPending(value)) {
        // stop updating
        currentCell.drop();
    }
    if (!succ) {
        throw value;
    }
    return value;
});


class Action {
    constructor (f) { this.f = f; }
};

// This should be called outside of the context of a cell update, because it
// will perform actions that may invalidate cells. (See ./i.md for more.)
//
const perform = (action) => {
    if (action instanceof Action) {
        action.f();  // IMPERATIVE
    } else if (action) {
        console.log("perform: unrecognized action", action);
    }
};

// Call fn(...args) -- reactive code that returns (optionally) an Action
//
const runHandler = (fn, ...args) => {
    // use() puts the onceCell in the root set, and it will remain there
    // until it completes.
    ifPending(onceCell(_ => {
        console.log("runHandler", ...args);
        const action = use(fn(...args));
        // Use setTimeout to get us out of the update context.
        // TBO: handle queue of actions in root dispatch?
        setTimeout(_ => perform(action));
    }));
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

const resultText = result => {
    if (result == null) {
        return "--no value--";
    }
    let [succ, v] = result;
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
        const current = (cell === currentCell ? "(CURRENT) " : "");
        const rtext = resultText(cell.result);
        const value = (cell.isDirty ? `dirty:${rtext}` : rtext);
        const out = [`${name}: ${current}${value}`];
        const f = cell.f;
        if (!options.brief && f && (f.fnxName || f.name)) {
            const fname = f.fnxName || f.name;
            const fargs = f.caps ? f.caps.map(valueText).join(",") : "()";
            out.push(` = ${fname}(${fargs})`);
        }
        if (cell.cleanups) {
            out.push(` cleanups: ${cell.cleanups.length}`);
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
    onceCell,
    Action,
    perform,
    runHandler,

    // debugging, testing
    logCell,
    resultText,
    setLogger,
    logError,
    getCurrentCell,
};
