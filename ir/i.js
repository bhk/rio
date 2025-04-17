// Incremental: incremental evaluation (see incremental.txt)
//
// High-level API: Used by functional code
//
//    defer(f)            Construct a thunk (lazy value)
//    use(v)              Extract value from cell or thunk
//    isThunk(v)          Return true if `v` is a thunk or cell
//    wrap(f)(...)        Evaluate f(...) inside a cell (*now*)
//    wrap(f).cell(...)   Return the cell that evaluates f(...)
//    useError(c)         Return [succeeded, result/thrownvalue]
//    usePending(c)       Return [done, result/pendingvalue]
//    Pending             A class describes temporary failures
//    checkPending(e)     value, if root cause of `e` was `new Pending(value)`
//    rootCause(e)        Dereference `cause` in Error objects, transitively
//    stream.newStream()
//    stream.filter(f)(s)
//    stream.map(f)(s)
//    stream.fold(f,z)(s)
//    stream.flatMap(f)(s)
//
// Low-level API: Used by imperative code
//
//    newState()          Create new state cell
//    newCell()           Create new function cell
//    onDrop(f)           Call f() when current cell's value is discarded
//    activate(f)         Decouple evaluation of f(), without memoizing
//

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
// Exceptions
//------------------------------------------------------------------------

// CellException is used to distinguish a cell in error state from all
// other possible cell values.

class CellException {
    constructor(error) {
        this.error = error;
    }
}

// A Pending object is thrown to indicate that an failure is temporary.
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

//------------------------------------------------------------------------
// Thunk & FnThunk
//------------------------------------------------------------------------

class Thunk {
}

class FnThunk extends Thunk {
    constructor(f) {
        super();
        this.f = f;
    }

    get() {
        return this.f.call(null);
    }
}

// Create a thunk that will be unwrapped by `use`.
//
const defer = (f) => new FnThunk(f);

// Force evaluation of a value.
//
const unthunk = (value) => {
    while (value instanceof Thunk) {
        value = value.get();
    }
    return value;
};

const rootCause = (e) => {
    while (e instanceof Error && e.cause) {
        e = e.cause;
    }
    return e;
};

// Recover `value` if error resulted from `throw new Pending(value)`
//
const checkPending = (error) => {
    const cause = rootCause(error);
    if (cause instanceof Pending) {
        return cause.value;
    }
};

let logRootError;

// Force evaluation and throw if value is in error state.
//
const use = (value) => {
    value = unthunk(value);
    if (value instanceof CellException) {
        logRootError(value.error);
        throw new Error("used error value", {cause: value.error});
    }
    return value;
};

// Return [true, RESULT] or [false, THROWNVALUE]
//
const useError = (value) => {
    const v = unthunk(value);
    return (v instanceof CellException
            ? [false, rootCause(v.error)]
            : [true, v]);
};

// Return [true, RESULT] or [false, PENDINGVALUE]  (rethrow other errors)
//
const usePending = (value) => {
    const v = unthunk(value);
    const p = v instanceof CellException && checkPending(v.error);
    return (p
            ? [false, p]
            : [true, use(v)]);
};

const isThunk = (value) => {
    return value instanceof Thunk;
};

const softApply = (f, v) => isThunk(v) ? defer(_ => f(use(v))): f(v);

//------------------------------------------------------------------------
// Cell
//------------------------------------------------------------------------
//
// A `Cell` describes a node in a dependency graph.  Cells may have inputs
// (cells they have used) and outputs (cells that use them).  "Function
// cells" may use other cells and be used.  "State cells" do not use other
// cells.  "Root cells" are not used by other cells.
//
// All cells implement implement the "used cell" interface:
//    update()
//    get()
//    addOutput()
//    removeOutput()
//
// Cells that depend on other cells implement the "using cell" interface:
//    setDirty()
//    addInput(cell, result)
//    removeInput()
//

class Cell extends Thunk {
    constructor(value, isDirty) {
        super();
        this.isDirty = isDirty;
        this.result = value;
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

    addOutput(p) {
        this.outputs.add(p);
    }

    removeOutput(p) {
        this.outputs.delete(p);
    }
}

//------------------------------------------------------------------------
// StateCell
//------------------------------------------------------------------------
//
// StateCell implements the "used cell" interface.
//

class StateCell extends Cell {
    constructor(initial) {
        super(intern(initial), false);
    }

    set(value) {
        value = intern(value);
        if (value !== this.result) {
            this.result = value;
            this.setDirty();
        }
    }

    setError(e) {
        this.set(new CellException(e));
    }

    update() {
        this.isDirty = false;
        return this.result;
    }

    get() {
        const result = this.update();
        currentCell.addInput(this, result);
        return result;
    }
}

const newState = (initial) => new StateCell(initial);

//------------------------------------------------------------------------
// FunCell
//------------------------------------------------------------------------

// currentCell holds the cell currently being evaluated.  Initialized below.
let currentCell;

// table for caching cells
const cellCache = new Map();

class FunCell extends Cell {
    constructor(f, args, key) {
        // isDirty is tri-state:
        //   false => result is valid
        //   true => may need recalc (validate inputs)
        //   "new" => needs recalc (has never been evaluated)
        super(null, "new");

        this.f = f;              // const
        this.args = args;        // const
        this.key = key;          // const
        this.inputs = null;
        this.cleanups = null;
        this.result = null;
    }

    // Return result & log this cell and its result as a depedendency of
    // currentCell.
    //
    get() {
        const result = this.update();
        // If, after evaluation, we have no resources to clean up and we
        // weren't memoized, then we don't need to track this dependency.
        if (this.inputs || this.cleanups || this.key) {
            currentCell.addInput(this, result);
        }
        return result;
    }

    // Called after our output has removed us...
    removeOutput(p) {
        this.outputs.delete(p);
        if (this.outputs.size == 0) {
            this.drop();
        }
    }

    // add/removeInput(c) call c.add/removeOutput()
    addInput(input, value) {
        if (this.inputs == null) {
            this.inputs = new Map();
        }
        this.inputs.set(input, value);
        input.addOutput(this);
    }

    removeInput(input) {
        this.inputs.delete(input);
        input.removeOutput(this);
    }

    // Call all registered `onDrop` functions.
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

        // remove from memo table
        if (this.key) {
            cellCache.delete(this.key);
        }

        // detach from inputs
        if (this.inputs != null) {
            for (const [input, result] of this.inputs) {
                input.removeOutput(this);
            }
            this.inputs = null;
        }
    }

    // Remove cell from all outputs.  This indirectly triggers this.drop().
    deactivate() {
        for (const output of [...this.outputs]) {
            output.removeInput(this);
        }
    }

    // Update: Recalculate if necessary.
    update() {
        if (!this.isDirty) {
            return this.result;
        }

        let isInvalid = false;

        if (this.isDirty == "new") {
            // node has not been calculated
            isInvalid = true;
        } else if (this.inputs) {
            // Validate cells in the order they were first evaluated,
            // to avoid recalculating un-live cells.
            for (const [cell, result] of this.inputs) {
                const value = cell.update();
                if (result !== value) {
                    isInvalid = true;
                    break;
                }
            }
        }

        this.isDirty = false;
        if (isInvalid) {
            this.recalc();
            assert(this.isDirty == false);
        }
        return this.result;
    }

    // Call f(args), watching for use of input cells
    //
    recalc() {
        this.cleanup();

        const oldInputs = this.inputs;
        this.inputs = null;

        const saveCurrentCell = currentCell;
        currentCell = this;
        try {
            this.result = intern(this.f.apply(null, this.args));
        } catch (e) {
            this.result = new CellException(e);
        }
        currentCell = saveCurrentCell;

        if (oldInputs != null) {
            // A cell cannot transition from some inputs to *none*
            // unless there is an untracked dependency.
            assert(this.inputs);
            for (const [input, value] of oldInputs) {
                if (!this.inputs.has(input)) {
                    input.removeOutput(this);
                }
            }
        }
    }
}

// Find a matching cell or create a new one.
//
const findCell = (f, args) => {
    args = intern(args);
    const key = intern([f, args]);
    return cache(cellCache, key, () => new FunCell(f, args, key));
}

//----------------------------------------------------------------
// RootCell
//----------------------------------------------------------------

// A RootCell has no outputs and is self-updating.
//
class RootCell extends FunCell {
    constructor() {
        // `f` and `args` are never referenced in RootCell
        super();
        this.isDirty = false;
        // this fake output exists only to trigger updates
        this.addOutput({
            setDirty: () => setTimeout(_ => use(this))
        });
    }

    // override get() to not add any outputs
    get() {
        return this.update();
    }

    // preserve inputs and update them; don't call onDrops
    recalc() {
        if (this.inputs) {
            for (const [input, _] of this.inputs) {
                use(input);
            }
        }
    }
};

// The globalRoot cell acts as output for all cell evaluations that occur
// outside of the scope of another cell's update.
const globalRoot = new RootCell();
currentCell = globalRoot;

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

// Log an error if we are outside of any cell.  When an error is not caught,
// browsers will display an error in the console but most will fail to
// display the stack traces for the `cause` errors, which are crucial for
// understanding what's going on.
//
logRootError = (e) => {
    if (currentCell == globalRoot) {
        logError(e, "Error caught at root");
    }
};

//----------------------------------------------------------------
// Cell-related APIs
//----------------------------------------------------------------

// Return cell that is currently being evaluated.
const getCurrentCell = () => currentCell;

// De-couple evaluation of f() without memoizing, returning the result.
// This prevents propagation of invalidation downstream.  Changes that
// invalidate `f(...args)` will not invalidate the caller will not
// necessarily invalidate the caller.  Invalidation of the caller will
// always re-evaluated `f(...args)`.
//
// This is often used to de-couple functions that set external state, which
// typically will never invalidate their caller.
//

const newCell = (f, ...args) => new FunCell(f, args);

const activate = (f, ...args) => {
    const cell = new FunCell(f, args);
    use(cell);     // make it a dependency
    return cell;
};

// Provide a function to be called when the current cell is deleted or
// re-evaluated.
//
const onDrop = (f) => currentCell.onDrop(f);

// Create or locate an existing cell that evaluates f(...args).
//
// If `fw = wrap(f)`, then:
//    `fw(...args)` obtains *and uses* a cell that evaluates f(...args)
//    `fw.cell(...args)` just returns the cell without calling `use`.
//
const wrap = (f) => {
    const useCell = (...args) => use(findCell(f, args));
    useCell.cell = (...args) => findCell(f, args);
    return useCell;
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
    const stream = newState(tail);

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
    let pos;
    const xfn = () => {
        let out = currentCell.result;
        const oldPos = pos;
        pos = use(xs);
        if (oldPos == null) {
            out = z;
        } else {
            pos.forEachSince(oldPos, x => {
                out = f(out, x);
            });
        }
        return out;
    };

    return new FunCell(xfn, []);
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
           v instanceof CellException ? `<Caught ${r(v.error)}>` :
           v instanceof Pending ? `<Pending ${r(v.value)}>` :
           v instanceof Function ? (v.name
                                    ? `${v.name}#${getID(v)}`
                                    : `<Fn#${getID(v)}>`) :
           v instanceof Error ? `<Error ${r(v.cause ?? v.message)}>` :
           v instanceof Array ? (depth == 0 ? `[${v.map(r)}]` : `[...]`) :
           `<${objName(v)}>`)) :
      typeof v == "string" ? '"' + v.replace(/\n/g, "\\n") + '"' :
      String(v);

const valueText = (v) => {
    const rr = depth => v => valueTextAt(depth, v, rr(depth+1));
    return rr(0)(v);
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
    root ??= (root === null ? globalRoot : currentCell);
    options ??= {};

    const getCellText = (cell) => {
        const name = cellName(cell);
        const value = valueText(cell.result);
        const dirty = cell.isDirty ? "! " : "";
        const out = [`${name}: ${dirty}${value}`];
        if (!options.brief && cell.f && cell.args
            && (cell.f.name || cell.args.length > 0)) {
            const fname = cell.f.name || "<f>";
            const fargs = cell.args.map(valueText);
            const ch = (cell.key ? "&" : "=");
            out.push(`  ${ch} ${fname}(${fargs})`);
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
    // High-level
    defer,
    use,
    isThunk,
    wrap,
    useError,
    usePending,
    checkPending,
    Pending,
    rootCause,
    stream,
    softApply,

    // Low-level API
    newState,
    newCell,
    onDrop,
    activate,

    // for testing & diagnostics
    getCurrentCell,
    logCell,
    valueText,
    setLogger,
    logError,
};
