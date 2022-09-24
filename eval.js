// eval: Evaluation of IL expressions

import {assert, eq, fail, printf} from "./test.js";
import {Op} from "./desugar.js";

// Pop `count` elements from array and return them.
let popN = (array, count) => {
    let i = array.length - count;
    let o = array.slice(i);
    array.length = i;
    return o;
};

let mapSet = (map, key, value) => (map.set(key, value), value);

let arraySet = (arr, key, value) => ((arr[key] = value), value);

// Environment

let envBind = (env, bindings) => ({T:"Env", env, bindings});

let envGet = (env, ups, pos) => {
    while (--ups >= 0) {
        env = env.env;
    }
    let b = env.bindings;
    assert(b[pos] !== undefined);
    return b[pos];
};

// Find the location of the Tag enclosing an op.
//
// frame = {expr, env, up, upii}
//
// We scan forward in the expression for an enclosing tag.  If one is not
// found, we find the tag enclosing the calling op.
//
let findTag = (frame, ii) => {
    let iiChild = ii;
    for (;;) {
        let op = frame.expr[++ii];
        if (!op) {
            break;
        } else if (op.T == "Tag" && op.n >= ii - iiChild) {
            return {frame, ii};
        }
    }
    return frame.up && findTag(frame.up, frame.upii);
};

// A Result describes evaluation of a Tag expression during eval.
//
//   .value = value computed (undefined if this expression faulted)
//   .errorName = error name (if this expression faulted)
//   .getChildren() = expressions evaluated by this expression
//   .getParent() = parent Result
//
class Result {
    constructor(frame, ii) {
        this.frame = frame;
        this.ii = ii;
        this.parent = null;
        this.value = undefined;
        this.children = [];
    }

    getAST() {
        return this.frame.expr[this.ii].ast;
    }

    getParent() {
        return this.parent;
    }

    getChildren() {
        return this.children;
    }
}

// index results by tag position (frame,ii)
//
// Returns map: frame -> ii -> Result
//
//
let indexResults = (trace, error) => {
    let map = new Map();

    let getResult = ({frame, ii}) => {
        let a = map.get(frame) || mapSet(map, frame, new Map());
        return a[ii] || arraySet(a, ii, new Result(frame, ii));
    };

    // Create/find a Result object from a result description -- {frame, ii,
    // value/errorName} -- and add it to the map, along with its parent.
    // Return the parent Result object.
    //
    let addResult = (rec) => {
        let result = getResult(rec);
        result.value = rec.value;
        result.errorName = rec.errorName;
        let parentPos = findTag(rec.frame, rec.ii);
        if (parentPos) {
            let parent = getResult(parentPos);
            result.parent = parent;
            parent.children.push(result);
            return parent;
        }
    };

    trace.forEach(addResult);

    // Manufacture error results for tags containing the error.

    // As of now, Eval.error, *unlike* the trace results, locates an IL
    // expression, not the tag (AST) expression, so we start at the tag
    // containing the error, and then work our way up.

    if (error) {
        let errorName = error.errorName;
        let pos = findTag(error.frame, error.ii);
        let result = getResult(pos);
        while (result) {
            result.errorName = errorName;
            result = addResult(result);
        }
    }
    return map;
}

//----------------------------------------------------------------
// ilEval
//
// frame = current activation record: {expr, env, up:FRAME, upii:II}
// ii = instruction index (in frame.expr)
// host = {
//   ILVal(type, arg) : constructs values described in IL.Val nodes
//   VFun             : constructs and deconstructs VFun values
//   call(fn, args)   : attempts to call a non-VFun value
// }
//
//----------------------------------------------------------------

let ilEval = (host) => (expr, env, args) => {
    let ILVal = host.ILVal;
    let VFun = host.VFun;
    let vcall = host.call;

    // execution state
    let values = [];       // stack of values
    let trace = [];        // array of {frame, ii, value}
    let error = null;
    let frame = null;
    let ii = 0;
    let results = null;

    let enter = (expr, captures, args, up, upii) => {
        let env = envBind(captures, args);
        frame = {expr, env, up, upii};
        ii = 0;
    };

    let fault = (errorName) => {
        error = {errorName, frame, ii};
        frame = null;
        ii = 0;
    };

    // step: (frame, ii) -> [frame, ii]
    let step = () => {
        let value;
        let op = frame.expr[ii];

        if (op.T == "Val") {
            value = ILVal(op.type, op.arg);
        } else if (op.T == "Arg") {
            value = envGet(frame.env, op.ups, op.pos);
        } else if (op.T == "Fun") {
            value = VFun(op.body, frame.env);
        } else if (op.T == "Err") {
            return fault(op.name);
        } else if (op.T == "App") {
            assert(values.length > op.nargs);
            let args = popN(values, op.nargs);
            let fn = values.pop();
            if (VFun.is(fn)) {
                return enter(VFun.body(fn), VFun.env(fn), args, frame, ii);
            }
            let [err, v] = vcall(fn, args);
            if (err != null) {
                return fault(err);
            }
            value = v;
        } else if (op.T == "Tag") {
            value = values.pop();
            trace.push({frame, ii, value});
        } else {
            fail("Unsupported: %q", op);
        }

        values.push(value);

        // return if at end of expression
        while (frame && ++ii >= frame.expr.length) {
            ii = frame.upii;
            frame = frame.up;
        };
    };

    // Execute until complete, or until `max` operations have been performed.
    //
    let sync = (max) => {
        if (max == undefined) {
            max = 1/0;
        }
        while (frame && --max >= 0) {
            step();
        }
    };

    // {frame, ii} -> Result
    //
    let findResult = ({frame, ii}) => {
        if (!results) {
            results = indexResults(trace, error);
        }
        return results.get(frame)[ii];
    };

    // Return final Result.  On fault, this will be the innermost tagged
    // expression containing the error.  Return `undefined` if no tagged
    // expressions have been evaluated.
    //
    let getResult = () => {
        if (frame) {
            return false; // not done
        }
        let pos = error
            ? findTag(error.frame, error.ii)
            : trace[trace.length - 1];
        return pos ? findResult(pos) : null;
    };

    enter(expr, env, args, null, 0);

    return {
        sync,       // make progress
        getResult,  // false => not done; null => no tagged result
        // debug/testing...
        findResult,
        getState: () => ({values, trace, error}),
    };
}

export {
    ilEval,
    envBind as evalEnvBind,
    envGet as evalEnvGet,
};

//--------------------------------
// Tests
//--------------------------------

// test findTag

let frameA = {
    expr: [
        Op.Arg(1, 0),
        Op.Arg(1, 1),
        Op.Tag("A:2", 1),
        Op.App(0),
        Op.Tag("A:4", 1),
        Op.Tag("A:5", 5),
    ],
    up: null,
    upii: 0,
};

let frameB = {
    expr: [
        Op.Arg(1, 1),     // untagged in this frame
        Op.Err("fault"),  // under B1
        Op.Tag("B:2", 1),
    ],
    up: frameA,
    upii: 3,
};

// enclosing tag is second one searched; same frame
eq(findTag(frameA, 0), {frame: frameA, ii: 5});
// enclosing tag is found in parent frame
eq(findTag(frameB, 0), {frame: frameA, ii: 4});

// test indexResults

let irMap = indexResults(
    [ {frame: frameA, ii: 2, ast: "A:2"} ],
    {frame: frameB, ii: 1, errorName: "ERROR"});
eq(irMap.get(frameA)[4].children.map(r => r.getAST()), ["B:2"]);
eq(irMap.get(frameA)[5].children.map(r => r.getAST()), ["A:2", "A:4"]);

// test Eval

let VFun = (body, env) => ({T:"VFun", env, body});
VFun.is = v => v.T == "VFun";
VFun.env = v => v.env;
VFun.body = v => v.body;

let testHost = {
    ILVal: (type, v) => ({T:type, v}),
    call: (v, args) => v.fn(...args),
    VFun,
};

let VStr = (v) => ({T:"VStr", v});
let VHFn = fn => ({T:"VHFn", fn});


let hfnCat = (vx, vy) => [null, VStr(vx.v + vy.v)];
let hfnTypeof = (v) => [null, VStr(v.T)];
let hfnErr = () => ["hfnErr"];

let testEnv = envBind(null, [VHFn(hfnTypeof), VHFn(hfnCat), VHFn(hfnErr)]);
let typeofArg = ups => Op.Arg(ups, 0);
let catArg = ups => Op.Arg(ups, 1);
let errArg = ups => Op.Arg(ups, 2);
let args = [ VStr("Hello"), VStr(" ") ];
let helloArg = Op.Arg(0, 0);
let spaceArg = Op.Arg(0, 1);

let testEval = (expr) => ilEval(testHost)(expr, testEnv, args);

// eval of  Val, Arg, Tag, App/VHFn

let expr = [
    catArg(1),
    helloArg,
    typeofArg(1),
    Op.Val("VType", 0),
    Op.App(1),          // -> "VType"
    Op.App(2),          // -> "HelloVType"
    Op.Tag("top", 1),
];

let e = testEval(expr);
e.sync();
eq(true, e.getResult !== false);
let {values, trace} = e.getState();
eq(values, [VStr("HelloVType")]);
eq(trace[0].value, VStr("HelloVType"));
eq(trace[0].ii, 6);

// eval of Fun, App/VFun
{
    let expr = [
        Op.Fun([
            // (a, b) => a .. b .. a
            catArg(2),
            catArg(2),
            Op.Arg(0, 0),
            Op.Arg(0, 1),
            Op.App(2),
            Op.Arg(0, 0),
            Op.App(2),
            Op.Tag("aba", 7),
        ]),
        helloArg,
        spaceArg,
        Op.App(2),
    ];
    let e = testEval(expr);
    e.sync();
    let {values, trace} = e.getState();
    eq(values, [VStr("Hello Hello")]);
    eq(trace[0].value, VStr("Hello Hello"));
    eq(trace[0].ii, 7);
    eq(trace[0].frame.expr[7].ast, "aba");
}

// eval of native function faulting

expr = [
      catArg(1),
      Op.Val("VStr", "test"),
      Op.Tag("A1", 1),
        Op.Fun([
            catArg(2),
            Op.Val("VStr", "b1"),
            Op.Tag("B1", 1),
            errArg(2),
            Op.App(0),
            Op.Tag("B2", 2),  // error
            Op.App(2),
        ]),
      Op.App(0),
      Op.Tag("A2", 2),
    Op.App(2),
    Op.Tag("A3", 7)
];
e = testEval(expr);
e.sync();
// assert: error reported
let b2 = e.getResult();
eq(b2.getAST(), "B2");
eq(b2.errorName, "hfnErr");

// getParent of error
let a2 = b2.getParent();
eq(a2.getAST(), "A2");
let a3 = a2.getParent();
eq(a3.getAST(), "A3");

// getChildren -> non-error & error
let a2c = a2.getChildren();
eq(a2c.map(r => r.getAST()), ["B1", "B2"]);
eq(a2c[0].value, VStr("b1"));
eq(a2c[1].errorName, "hfnErr");
eq(a3.getChildren().map(r => r.getAST()), ["A1", "A2"]);
