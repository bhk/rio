// host: host functions and types for evaluation

import {assert, eq, fail, printf} from "./test.js";
import {set} from "./misc.js";

// TODO: integrate "class" work from interp.js: VObj, VCls, NewClass

// The initial "touch point" with eval is the Host structure supplied to
// eval.
//
//   ILVal : constructs values described in IL.Val nodes
//   call : attempt to call a non-VFun value
//   VFun, VFun.is, VFun.env, VFun.body : construct/deconstruct VFun's
//
// ILVal("lib", NAME) is called to obtain "root" library functions (those
// directly referenced by code emitted by desugar):
//
//   getProp : (Value, VStr) -> Value
//   stop : () -> VErr
//   vecNew : (Value...) -> VVec
//   mapDef : (Value...) -> (Value...) -> VMap
//
// Notably, getProp returns other host functions (host functions, or
// IL functions that reference other host functions) that make up the
// bulk of data type support.

//==============================================================
// Values
//==============================================================

// Note: VErr is a pseudo-value returned by host functions to indicate an
//    error that halts execution.  It is never passed to functions.

let VBool = (v) => ({T:"VBool", v});  // v = host bool
let VNum = (v) => ({T:"VNum", v});    // v = host number
let VStr = (v) => ({T:"VStr", v});    // v = host string
let VVec = (v) => ({T:"VVec", v});    // v = host Array
let VHFn = (v) => ({T:"VHFn", v});    // v = host function
let VFun = (body, env) => ({T:"VFun", env, body});
let VMap = (pairs) => ({T:"VMap", pairs});
let VObj = (cls, values) => ({T:"VObj", cls, values});
let VCls = (fields) => ({T:"VCls", fields});
let VErr = (name) => ({T:"VErr", name});

// Construct a Value from a host language value (or a Value)
let wrap = (value) =>
    typeof value == "boolean" ? VBool(value) :
    typeof value == "number" ? VNum(value) :
    typeof value == "string" ? VStr(value) :
    typeof value == "function" ? VHFn(value) :
    value instanceof Array ? VVec(value) :
    value.T ? value :
    fail("wrap: unknown value");

// Unwrap a host value from a Value (if it is a wrapped host value)
let unwrap = (value) =>
    (!value.T ? fail("unwrap: unknown value: " + serialize(value)) :
     value.v !== undefined ? value.v :
     value);

// Two arrays --> an array of pairs
let zip = (a, b) => a.map((e, i) => [e, b[i]]);

let fmtPairs = (pairs) =>
    pairs.map(([key, value]) => key + ": " + valueFmt(value)).join(", ");

// Format a value as Rio source text that produces that value (except for
// functions)
//
let valueFmt = v =>
    v.T == "VBool" ? String(v.v) :
    v.T == "VNum" ? String(v.v) :
    v.T == "VStr" ? '"' + v.v + '"' :
    v.T == "VVec" ? '[' + v.v.map(valueFmt).join(', ') + ']' :
    v.T == "VMap" ? "{" + fmtPairs(v.pairs) + '}' :
    v.T == "VFun" ? '(...) -> BODY' :
    v.T == "VErr" ? ("(VErr " + astFmt(v.name) + ")" ) :
    v.T == "VObj" ? "(VObj " + fmtPairs(zip(v.fields, v.values)) + ")" :
    v.T == "VCls" ? "(VCls " + v.fields.join(" ") + ")" :
    v.T == "VHFn" ? "(VNfn " + (v.v.name || v.v.toString()) + ")" :
    "UnknownValue: " + serialize(v);

let vassert = (cond, desc) =>
    !cond && VErr(desc);

let vassertType = (type, what) =>
    what.T !== type && VErr("Expected" + type);

let vassertArity = (n, args) =>
    args.length != n && VErr("ArityNot" + n);

let unknownProperty = (value, name) => {
    value = wrap(value);
    name = wrap(name);
    return VErr(name.T == "VStr"
                ? "UnknownProperty:" + value.T + "/" + name.v
                : "BadPropertyType:" + name.T);
};

//--------------------------------
// Object System: Types and Properties
//--------------------------------

// Each type has a "behavior", an object that maps property names to
// "accessors".
//
//    behaviors[value.T] -> behavior
//    behavior[propName] -> accessor
//    accessor(value)    -> propValue
//
// For example, when "1 + 2" is evaluated, the following JS is executed:
//
//    behaviors["VNum"]["+"](VNum(1))(VNum(2))
//
// Behaviors are not exposed to the surface language, so accessors can
// assume the type of their argument.
//
// Converting an "ordinary" JS function to a method accessor involves
// the following:
//
//    Lift (or lower) : convert function that accepts and returns JS-native
//        types to one that accepts/returns wrapped types (or vice-versa).
//    Uncurry : convert a function `(a, ...) -> x` to `a -> ... -> x`.
//

// Create a method -- an accessor that returns a function -- from
// a function that accepts JS-native types: (self, args) -> value
//
let makeMethod = (fn) => (self) => VHFn((...args) => fn(self, args));

// Convert a "trivial binop" -- `(a, b) -> ...` -- to an accessor:
// uncurry, lift, and validate arity and the type of `b`.
//
let makeBinop = (type, fn) => makeMethod(
    (self, args) =>
        vassertArity(1, args)
        || vassertType(type, args[0])
        || wrap(fn(unwrap(self), unwrap(args[0]))));

// Convert a "trivial unop" -- `(a) -> ...` -- to an accessor: uncurry,
// lift, and check arity.
//
let makeUnop = (fn) => (value) => wrap(fn(unwrap(value)));

// Construct the behavior for a type.  See makeMethod/Binop/Unop, above.
//
let makeBehavior = (unops, binops, methods, typeName, base) => {
    let b = base ? {...base} : Object.create(null);

    for (let [name, fn] of Object.entries(unops)) {
        b[name] = makeUnop(fn);
    }
    for (let [name, fn] of Object.entries(binops)) {
        b[name] = makeBinop(typeName, fn);
    }
    for (let [name, fn] of Object.entries(methods)) {
        b[name] = makeMethod(fn);
    }
    return b;
};

let getPropFor = (behaviors) => (...args) => {
    assert(args.length == 2);
    let [value, name] = args;
    let behavior = assert(behaviors[value.T]);
    let accessor;
    return vassertType("VStr", name)
        || (accessor = behavior[name.v],
            vassert(accessor, "UnknownProperty")
            || accessor(value));
};

let behaviors = Object.create(null);
let getProp = getPropFor(behaviors);

//==============================
// VFun (exclusively constructed by `eval`...)
//==============================

behaviors.VFun = {};

//==============================
// VBool
//==============================

let boolUnops = {
    "not": (b) => !b,
};

let boolBinops = {
    "@or": (a, b) => a || b,
    "@and": (a, b) => a && b,
    "@==": (a, b) => a == b,
    "@!=": (a, b) => a !== b,
};

let boolMethods = {
    "switch": (vself, args) => {
        let self = unwrap(vself);
        return args.length == 2
            ? (self ? args[0] : args[1])
            : VErr("SwitchArity", args[2]);
    },
};

behaviors.VBool = makeBehavior(boolUnops, boolBinops, boolMethods, "VBool");

//==============================
// VNum
//==============================

let numUnops = {
    "-": (a) => -a,
};

let numBinops = {
    "@^": (a, b) => a ^ b,
    "@*": (a, b) => a * b,
    "@/": (a, b) => a / b,
    "@//": (a, b) => Math.floor(a / b),
    "@%": (a, b) => a % b,
    "@+": (a, b) => a + b,
    "@-": (a, b) => a - b,
    "@<": (a, b) => a < b,
    "@==": (a, b) => a == b,
    "@!=": (a, b) => a !== b,
    "@<=": (a, b) => a <= b,
    "@<": (a, b) => a < b,
    "@>=": (a, b) => a >= b,
    "@>": (a, b) => a > b,
};

behaviors.VNum = makeBehavior(numUnops, numBinops, {}, "VNum");

//==============================
// VStr
//==============================

let strUnops = {
    len: (v) => v.length,
};

// "Operators" operate on two values of the same type
let strBinops = {
    "@<": (a, b) => a < b,
    "@==": (a, b) => a == b,
    "@!=": (a, b) => a !== b,
    "@<=": (a, b) => a <= b,
    "@<": (a, b) => a < b,
    "@>=": (a, b) => a >= b,
    "@>": (a, b) => a > b,
    "@++": (a, b) => a + b,
};

let strMethods = {
    slice: (vself, args) => {
        let [vstart, vlimit] = args;
        let self = unwrap(vself);
        let start = unwrap(vstart);
        let limit = unwrap(vlimit);
        return vassertType("VNum", vstart)
            || vassertType("VNum", vlimit)
            || vassert(start >= 0 && start < self.length, "Bounds", vstart)
            || vassert(limit >= start && limit < self.length, "Bounds", vstart)
            || wrap(self.slice(start, limit));
    },

    "@[]": (vself, args) => {
        let [voffset] = args;
        let self = unwrap(vself);
        let offset = unwrap(voffset);
        return vassertType("VNum", voffset)
            || vassert(offset >= 0 && offset < self.length, "Bounds", offset)
            || wrap(self.charCodeAt(offset));
    },
};

behaviors.VStr = makeBehavior(strUnops, strBinops, strMethods, "VStr");

//==============================
// VVec
//==============================

let vecUnops = {
    len: (v) => v.length,
};

let vecBinops = {
    "@++": (a, b) => [...a, ...b],
};

let vecMethods = {
    slice: (vself, args) => {
        let self = unwrap(vself);
        let [vstart, vlimit] = args;
        let start = unwrap(vstart);
        let limit = unwrap(vlimit);
        return vassertType("VNum", vstart)
            || vassertType("VNum", vlimit)
            || vassert(start >= 0 && start < self.length, "Bounds", vstart)
            || vassert(limit >= start && limit <= self.length, "Bounds", vlimit)
            || wrap(self.slice(start, limit));
    },

    set: (vself, args) => {
        let self = unwrap(vself);
        let [vindex, value] = args;
        let index = unwrap(vindex);
        return vassertType("VNum", vindex)
            // enforce contiguity (growable, but one at a time)
            || vassert(index >= 0 && index <= self.length, "Bounds", vindex)
            || wrap(set(self, index, value));
    },

    "@[]": (vself, args) => {
        let self = unwrap(vself);
        let [voffset] = args;
        let offset = unwrap(voffset);
        return vassertType("VNum", voffset)
            || vassert(offset >= 0 && offset < self.length, "Bounds", voffset)
            || wrap(self[offset]);
    },
};

behaviors.VVec = makeBehavior(vecUnops, vecBinops, vecMethods, "VVec");

let vvecNew = (...args) => VVec(args);

//==============================
// VMap
//==============================

let pairsFind = (pairs, name, ifNotFound) => {
    for (let [index, pair] of pairs.entries()) {
        if (pair[0] === name) {
            return index;
        }
    }
    return ifNotFound || -1;
}

let mapBinops = {
};

let mapMethods = {
    set: (vself, args) => {
        let [vname, value] = args;
        let pairs = vself.pairs;
        let name = unwrap(vname);
        return vassertType("VStr", vname)
            || VMap(set(pairs, pairsFind(pairs, name, pairs.length),
                        [name, value]));
    },

    "@[]": (vself, args) => {
        let [vkey] = args;
        let pairs = vself.pairs;
        let index = pairsFind(pairs, unwrap(vkey));
        return vassertType("VStr", vkey)
            || vassert(index >= 0, "NotFound", vkey)
            || wrap(pairs[index][1]);
    },
};

behaviors.VMap = makeBehavior({}, mapBinops, mapMethods, "VMap");

let vmapNew = (...names) => (...values) => {
    let pairs = [];
    for (let ii of names.keys()) {
        let key = unwrap(names[ii]);        // TODO: assert string?
        pairs[ii] = [key, values[ii]];
    }
    return VMap(pairs);
};

// vmapDef: names -> values -> map
let vmapDef = (...names) => VHFn(vmapNew(...names));

//==============================
// Host
//==============================

let stop = () => VErr("Stop");

let builtins = {
    "vecNew": VHFn(vvecNew),
    "mapDef": VHFn(vmapDef),
    "stop": VHFn(stop),
    "getProp": VHFn(getProp),
};

let ILVal = (type, arg) => {
    if (type == "Lib") {
        return assert(builtins[arg]);
    } else if (type == "String") {
        return wrap(String(arg));
    } else if (type == "Number") {
        // use host type for numbers
        return wrap(Number(arg));
    } else {
        fail("Unexpected IVal type");
    }
};

// accessors used by eval via Host
VFun.is = v => v.T == "VFun";
VFun.env = v => v.env;
VFun.body = v => v.body;

let hostCall = (v, args) => {
    if (v.T == "VHFn") {
        let value = v.v(...args);
        if (value.T == "VErr") {
            return [assert(value.name)];
        } else {
            return [null, value];
        }
    } else {
        return ["NotAFunction"];
    }
};

let Host = {
    ILVal,
    VFun,
    call: hostCall,
    // other types
    VBool,
    VHFn,
};

export {Host, valueFmt};

//==============================================================
// Tests
//==============================================================

// test wrap/unwrap

eq(wrap(false), {T:"VBool", v:false});
eq(unwrap(wrap(false)), false);
eq(unwrap(wrap(1)), 1);
eq(unwrap(wrap("a")), "a");

// test object system

// Evaluate a property using unwrapped values
let testPropFor = (getProp) => (value, name) => {
    let o = getProp(wrap(value), wrap(name));
    assert(o.T); // property should be wrapped
    return unwrap(o);
};

// Call a method using unwrapped values
let testSendFor = (getProp) => (value, name, ...args) => {
    let fn = testPropFor(getProp)(value, name);
    assert(typeof fn == "function");
    let o = fn(...args.map(wrap));
    assert(o.T); // result should be wrapped
    return unwrap(o);
};

// test makeUnop, makeBinop, makeMethod, makeBehavior

{
    let binops = { add: (x,y) => x+y };
    let unops = { neg: (x) => -x };
    let methods = { count: (x, args) => VNum(args.length) };
    let b = makeBehavior(unops, binops, methods, "VNum", null);
    let gp = getPropFor({VNum: b});
    let send = testSendFor(gp);
    let prop = testPropFor(gp);

    eq(prop(3, 3), VErr("ExpectedVStr"));
    eq(prop(3, "xx"), VErr("UnknownProperty"));
    eq(prop(3, "neg"), -3);

    eq(send(7, "add", 2), 9);
    eq(send(1, "count", 9, 9), 2);
}

let prop = testPropFor(getProp);
let send = testSendFor(getProp);

// test VBool

eq(prop(true, "not"), false);
eq(send(true, "@or", false), true);
eq(send(false, "@or", false), false);
eq(send(true, "switch", 1, 2), 1);
eq(send(false, "switch", 1, 2), 2);

// test VNum

eq(prop(3, "-"), -3);
eq(send(5, "@//", 2), 2);

// test VStr

eq(prop("abc", "len"), 3);
eq(send("x", "@++", "y"), "xy");
eq(send("abc", "slice", 1, 2), "b");
eq(send("abc", "@[]", 1), 98);

// test VVec

eq(vvecNew(wrap(9), wrap(8)), VVec([VNum(9), VNum(8)]));

let va = wrap("a");
let vb = wrap("b");
eq(prop([va, vb], "len"), 2);
eq(send([va, vb], "@++", [vb, va]), [va, vb, vb, va]);
eq(send([va, vb], "slice", 1, 2), [vb]);
eq(send([va, vb], "set", 0, 2), [VNum(2), vb]);
eq(send([vb, va], "@[]", 1), "a");

// test VMap

let tm = vmapNew(va, vb)(wrap(1), wrap(2));
eq(0, pairsFind(tm.pairs, "a"));
eq(1, pairsFind(tm.pairs, "b"));
eq(-1, pairsFind(tm.pairs, "x"));
eq(99, pairsFind(tm.pairs, "x", 99));

eq(send(tm, "@[]", "b"), 2);
eq(send(tm, "@[]", "x"), VErr("NotFound"));
eq(send(send(tm, "set", "b", 3),
        "@[]", "b"),
   3);

// test Host.call, Host.ILVal("Lib", ...), Host.ILVal("String", ...)

import {ilEval} from "./eval.js";
import {Op, IL} from "./desugar.js";

let eh = ilEval(Host);
let e = eh(IL.Tag("TOP",
                  IL.App(
                      IL.App(IL.Val("Lib", "getProp"), [
                          IL.Val("String", "abc"),
                          IL.Val("String", "@++"),
                      ]),
                      [ IL.Val("String", "def") ])),
           {}, {});

e.sync();
eq(e.getResult().value, wrap("abcdef"));
