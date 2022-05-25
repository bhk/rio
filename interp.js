import {eq, eqAt, serialize, assert, fail, printf} from "./test.js";
import {clone, override, map, set, L} from "./misc.js";
import {astFmt, astFmtV, parseModule} from "./syntax.js";
import {Env, IL} from "./desugar.js";

let log = false;
let logf = (...args) => { if (log) printf(...args); }

//==============================================================
// Stacks
//==============================================================

// evalIL() uses immutable stacks. stackPush() returns a new stack.
// In stackGet(), index 0 is the most-recently pushed value.

let emptyStack = [];

let stackPush = (stack, arg) => [arg, ...stack];

let stackGet = (stack, index) => stack[index];

// Construct env & matching stack from a map {varName -> value}
let makeManifest = (vars) => {
    let names = Object.keys(vars).sort();
    let values = names.map(k => vars[k]);
    let env = new Env(names);
    let stack = stackPush(emptyStack, values);
    return [env, stack];
};

//==============================================================
// Built-In Types
//==============================================================

// A Rio built-in Value is a JS object with T: TYPE, where TYPE
// is one of: VBool, VNum, VStr, VMap, VObj, VFun, VNFn, VErr.
//
// VErr is a fatal error or exception.  It is never passed to a
// Rio function; when returned by a native function, it causes
// the interpreter loop to terminate.
//

let VBool = (v) => ({T:"VBool", v});  // v = native bool
let VNum = (v) => ({T:"VNum", v});    // v = native number
let VStr = (v) => ({T:"VStr", v});    // v = native string
let VVec = (v) => ({T:"VVec", v});    // v = native Array
let VNFn = (v) => ({T:"VNFn", v});    // v = native function
let VMap = (pairs) => ({T:"VMap", pairs});
let VObj = (cls, values) => ({T:"VObj", cls, values});
let VCls = (fields) => ({T:"VCls", fields});
let VFun = (stack, body) => ({T:"VFun", stack, body});
let VErr = (desc, what) => ({T:"VErr", desc, what});

let matchFun = (value, ifStackBody, ifNat, ifNot) =>
    (value.T == "VFun" ? ifStackBody(value.stack, value.body) :
     value.T == "VNFn" ? ifNat(value.v) :
     ifNot());

//==============================================================
// Eval
//==============================================================

// tasks[] holds a stack of structures akin to activation records.  Each
//   maintains the state of evaluating a list of sub-nodes.
// values[] holds a stack of values that have been computed from sub-nodes.
//
class Eval {
    constructor(node, stack, ctors) {
        this.ctors = ctors;
        this.values = [];
        this.tasks = [];
        this.done = false;
        this.reduce(node, stack);
    }

    // Add a value to the end of values[]
    push(value) {
        if (value.T == "VErr") {
            this.done = true;
        }
        this.values.push(value);
    }

    // Given an IL node, push its value, or a task that will push its value.
    reduce(node, stack) {
        let value;
        if (node.T == "IVal") {
            let [ty, arg] = node;
            value = this.ctors(ty, arg);
        } else if (node.T == "IArg") {
            let [ups, pos] = node;
            let frame = stackGet(stack, ups);
            assert(frame !== undefined && frame[pos] !== undefined);
            value = frame[pos];
        } else if (node.T == "IFun") {
            let [body] = node;
            value = VFun(stack, body);
        } else if (node.T == "IErr") {
            let [desc] = node;
            value = VErr(desc, null);
        } else if (node.T == "IApp") {
            let [fn, args] = node;
            this.tasks.push({n: 0, subNodes: [fn, ...args], stack, node});
            return;
        } else {
            fail("Unsupported: %q", node);
        }

        this.push(value);
    }

    step() {
        if (this.done || this.tasks.length == 0) {
            this.done = true;
            return false;
        }
        let {n, subNodes, stack, node} = this.tasks.pop();

        if (n < subNodes.length) {
            this.tasks.push({n: n+1, subNodes, stack, node});
            this.reduce(subNodes[n], stack);
        } else {
            assert(node.T == "IApp");
            let vi = this.values.length - n;
            let fnValue = this.values[vi];
            let argValues = this.values.slice(vi + 1);
            this.values = this.values.slice(0, vi);
            matchFun(fnValue,
                     (env, body) => this.reduce(body, stackPush(env, argValues)),
                     (fnNative) => this.push(fnNative(...argValues)),
                     () => this.push(VErr("NotAFunction", fn))
                    );
        }
        return true;
    }

    sync() {
        while (this.step()) {}
        return this.values[this.values.length - 1];
    }
};

//==============================================================
// Implementation of Built-In Types
//==============================================================

// Construct a Value record from its native (JS) type
let wrap = (value) =>
    typeof value == "boolean" ? VBool(value) :
    typeof value == "string" ? VStr(value) :
    typeof value == "number" ? VNum(value) :
    typeof value == "function" ? VNFn(value) :
    value instanceof Array ? VVec(value) :
    value.T ? value :
    fail("wrap: unknown value");

// Recover native (JS) type from a Value (if othere is one)
let unwrap = (value) =>
    (!value.T ? fail("unwrap: unknown value: " + serialize(value)) :
     value.v !== undefined ? value.v :
     value);

{
    // test wrap/unwrap
    eq({T:"VBool", v:false}, wrap(false));
    eq(false, unwrap(wrap(false)));
    eq(1, unwrap(wrap(1)));
    eq("a", unwrap(wrap("a")));
}

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
    v.T == "VFun" ? '(...) -> ' + IL.fmt(v.body) :
    v.T == "VErr" ? ("(VErr " + astFmt(v.desc) +
                     (v.what ? " " + valueFmt(v.what) : "") +
                     ")") :
    v.T == "VObj" ? "(VObj " + fmtPairs(zip(v.fields, v.values)) + ")" :
    v.T == "VCls" ? "(VCls " + v.fields.join(" ") + ")" :
    v.T == "VNFn" ? "(VNfn " + (v.v.name || v.v.toString()) + ")" :
    "UnknownValue: " + serialize(v);

let vassert = (cond, desc, what) =>
    !cond && VErr(desc, what);

let vassertType = (type, what) =>
    what.T !== type && VErr("Expected " + type, what);

// A type's "behavior" is a function that obtains properties of its values:
//   (value, propertyName) -> propertyValue
//
let behaviors = Object.create(null);

let getProp = (value, name) => {
    let gp = behaviors[value.T];
    return gp(value, name);
};

let unknownProperty = (value, name) =>
    VErr("UnknownProperty:" + name, value);

// Wrap a "native" binop function with a VNFn-suitable function.
// as a "Lib" function.
//
let wrapBinop = (typeName) => (fn) => (a, args) => {
    // The surface language calling convention, used to call the
    // method, puts its argument in a vector (arg bundle).
    let [b] = args;
    return vassertType(typeName, b)
        || wrap(fn(unwrap(a), unwrap(b)));
};

let wrapUnop = (fn) => (v) => wrap(fn(unwrap(v)));

// Construct a binary operator property: a function that takes one argument
// and calls `nativeMethod` with (self, arg).
//
// nativeMethod: (self, args) -> value
// result: (value) -> VFun that calls `nativeMethod` with `value` and its arg
//
let makeMethodProp = (nativeMethod) => (value) =>
    VNFn( (...args) => nativeMethod(value, args));

// Construct a behavior from a map of property names to functions that
// construct properties.
//
let behaviorFn = (propCtors, base) => {
    base = base || unknownProperty;
    return (value, vname) => {
        let name = unwrap(vname);
        let pfn = propCtors[name];
        if (pfn) {
            return pfn(value);
        }
        return base(value, name);
    };
};

// Construct the behavior for a type.
//
// unops: propName -> (self) -> value
// binops: propName -> (self, b) -> value
// methods: propName -> (self, args) -> value
//
// `unops` receive only `self` and return the property value.  A `unop`
//   is equivalent to a `getProperty` function.
//
// `binops` and `methods` result in the property resolving to a function,
//   and they will be called only when (and if) the property is invoked.
//   Binop functions receive the extracted second argument, after it has
//   been verified to be of the same type as `self`.  Method functions
//   receive the arg bundle directly.
//
let makeBehavior = (unops, binops, methods, typeName, base) => {
    let nativeMethods = map(binops, wrapBinop(typeName));
    override(nativeMethods, methods);

    let propCtors = map(nativeMethods, makeMethodProp);
    override(propCtors, map(unops, wrapUnop));
    return behaviorFn(propCtors, base);
};

//==============================
// VFun (exclusively constructed by `eval`...)
//==============================

behaviors.VFun = (value, name) => {
    return unknownProperty(value, name);
};

//==============================
// VBool (happens to be a native boolean)
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
// VStr  (happens to be a native string)
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
// VNum (happens to be a native number)
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
            || vassert(limit >= start && limit < self.length, "Bounds", vlimit)
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

// Note different calling convention than `@[]`.
//
let vvecNth = (vself, vn) => {
    let self = unwrap(vself);
    let n = unwrap(vn);
    return vassertType("VVec", vself)
        || vassertType("VNum", vn)
        || vassert(n >= 0 && n < self.length, "Bounds", vself)
        || wrap(self[n]);
};

{
    // test VVec
    let tv1 = vvecNew(wrap(9), wrap(8));
    eq(tv1, VVec([wrap(9), wrap(8)]));
    eq(unwrap(vvecNth(tv1, wrap(0))), 9);
}

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

let mapBase = makeBehavior({}, mapBinops, mapMethods, "VMap");

behaviors.VMap = (vself, vname) => {
    let name = unwrap(vname);  // TODO: assert string?
    let pairs = vself.pairs;
    let ndx = pairsFind(pairs, name);
    return ndx < 0
        ? mapBase(vself, vname)
        : pairs[ndx][1];
};

let vmapNew = (...names) => (...values) => {
    let pairs = [];
    for (let ii of names.keys()) {
        let key = unwrap(names[ii]);        // TODO: assert string?
        pairs[ii] = [key, values[ii]];
    }
    return VMap(pairs);
};

// vmapDef: names -> values -> map
let vmapDef = (...names) => VNFn(vmapNew(...names));

{
    // test VMap
    let rval = vmapNew(wrap("a"), wrap("b"))(wrap(1), wrap(2));
    eq(0, pairsFind(rval.pairs, "a"));
    eq(1, pairsFind(rval.pairs, "b"));
    eq(-1, pairsFind(rval.pairs, wrap("x")));
    eq(99, pairsFind(rval.pairs, wrap("x"), 99));
    eq(unwrap(behaviors.VMap(rval, wrap("b"))), 2);
    let rv2 = mapMethods.set(rval, [wrap("b"), wrap(7)]);
    eq(unwrap(behaviors.VMap(rv2, wrap("b"))), 7);
}

//==============================
// VObj & VCls
//==============================

let objSetProp = (vself) => (vname, vvalue) => {
    let {cls, values} = vself;
    let name = unwrap(vname);
    let index = cls.fields.indexOf(name);
    return vassertType("VStr", vname)
        || vassert(index >= 0, "Unknown", vname)
        || VObj(cls, set(values, index, value));
};

behaviors.VObj = (vself, vprop) => {
    let {cls, values} = vself;
    let prop = unwrap(vprop);
    let index;
    return vassertType("VStr", vprop)
        || prop == "setProp" && objSetProp(vself)
        || vassert((index = cls.fields.indexOf(prop)) >= 0, "Unknown", vprop)
        || values[index];
};

// Class.new(...values) -> object
let VCls_new = (vself) => {
    let {fields} = vself;
    let ctor = (...values) => {
        assert(values.length == fields.length);
        return VObj(vself, values);
    };
    return VNFn(ctor);
};

// match = (class) => (self, fnThen, fnElse) =>
//     if $is(class, self):
//        fnThen(...$members(self))
//     fnElse()
//
let VCls_match = (vclass) => {
    let ilClass = IL.Arg(1, 0);
    let ilValue = IL.Arg(0, 0);
    let ilValue2 = IL.Arg(1, 0);   // when nested within an IFun
    let memberValues = vclass.fields.map(
        (name, idx) => IL.prop(ilValue2, name)
    );
    //  (value, fnThen, fnElse) -> result
    return VFun(
        stackPush(emptyStack, [vclass]),
        // Note: IIF wraps the `then` and `else` expressions in a IFun, so all
        //    IArg `ups` values must be incremented by one.
        IL.iif(IL.App(IL.prop(ilClass, "matches"), [ilValue]),
               IL.App(IL.Arg(1, 1), memberValues),  // ifThen
               IL.App(IL.Arg(1, 2), []))            // ifElse
    );
};

let VCls_has = (vclass) =>
    VNFn((value) => wrap(value.T == "VObj" && value.cls == vclass));

behaviors.VCls = (vself, vprop) => {
    let prop = unwrap(vprop);
    return vassertType("VStr", vprop)
        || prop == "new" && VCls_new(vself)
        || prop == "matches" && VCls_has(vself)
        || prop == "match" && VCls_match(vself)
        || VErr("UnknownProp", vprop);
};

let NewClass = (vmap) => {
    assert(vmap.T == "VMap");
    let fields = vmap.pairs.map(([key, value]) => key);
    return VCls(fields);
};

{
    // test VObj & VCls
    let tmap = vmapNew(wrap("a"), wrap("b"))(wrap(true), wrap(true));
    let cls = NewClass(tmap);
    assert(cls.T == "VCls");

    // new()
    let fnew = unwrap(getProp(cls, wrap("new")));
    let obj = fnew(wrap(1), wrap(2));
    assert(obj.T == "VObj");
    eq(unwrap(getProp(obj, VStr("a"))), 1);

    // matches()
    let fmatches = unwrap(getProp(cls, wrap("matches")));
    assert(unwrap(fmatches(obj)), true);

    // match()
    let vmatch = getProp(cls, wrap("match"));
    assert(vmatch.T == "VFun");
}

//==============================
// Store names of native functions for debugging
//==============================

let stop = () => VErr("Stop", null);

let builtins = {
    "vecNew": VNFn(vvecNew),
    "mapDef": VNFn(vmapDef),
    "stop": VNFn(stop),
    "getProp": VNFn(getProp),
};

let builtinCtors = (type, arg) => {
    if (type == "Lib") {
        assert(builtins[arg]);
        return builtins[arg];
    } else if (type == "String") {
        return wrap(String(arg));
    } else if (type == "Number") {
        // use native type for numbers
        return wrap(Number(arg));
    } else {
        fail("Unexpected IVal type");
    }
};

let manifestVars = {
    "true": VBool(true),
    "false": VBool(false),
    "NewClass": VNFn(NewClass),
};

let [manifestEnv, manifestStack] = makeManifest(manifestVars);

let evalAST = (ast) => {
    let il = manifestEnv.desugar(ast);
    return new Eval(il, manifestStack, builtinCtors).sync();
};

//==============================================================
// Tests
//==============================================================

let ET = (source, valueOut, oobOut) => {
    //printf("ET: %s\n", valueOut);
    source = L(source).replace(/ \| /g, "\n");
    let [ast, oob] = parseModule(source);
    eqAt(2, "OOB: " + (oobOut || ""), "OOB: " + astFmtV(oob || []));
    eqAt(2, valueFmt(evalAST(ast)), valueOut);
};

// manifest variables

ET("true", 'true');

// parse error

ET(".5", "0.5", '(Error "NumDigitBefore")');

// eval error

ET("x", '(VErr "Undefined:x")');

// literals and constructors

ET("1.23", "1.23");
ET('"abc"', '"abc"');
ET("[1,2,3]", "[1, 2, 3]");
ET("{a: 1, b: 2}", "{a: 1, b: 2}");

// Fn

ET("x -> x", '(...) -> $0:0');

// Function calls

ET("(x -> x)(2)", "2");
ET("(x -> [x])(2)", "[2]");
ET("(x -> [x]) $ 2", "[2]");

// operators and properties ...

// ... Boolean
ET("not (1==1)", "false");
ET("1==1 or 1==2", "true");
ET("1==1 and 1==2", "false");
ET("(1==1) != (1==2)", "true");
ET("(2==2).switch(1,0)", "1");
ET("(2==3).switch(1,0)", "0");

// ... Number
ET("1 + 2", "3");
ET("7 // 3", "2");
ET("-(1)", "-1");
ET("1 < 2", "true");
ET("1 < 2 < 3", "true");

// ... String
ET(' "abc" ++ "def" ', '"abcdef"');
ET(' "abc".len ', '3');
ET(' "abcd".slice(1, 3) ', '"bc"');
ET(' "abc" == "abc" ', 'true');
ET(' "abc"[1] ', '98');

// ... Vector
ET("[7,8,9].len", "3");
ET("[7,8,9][1]", "8");
ET("[7,8,9,0].slice(1,3)", "[8, 9]");
ET("[7,8,9,0].slice(1,1)", "[]");
ET("[7,8,9].set(1, 2)", "[7, 2, 9]");

// ... Map
ET("{a:1}.a", "1");
ET('{a:1}.set("b",2).set("a",3)', "{a: 3, b: 2}");

// If

ET("if 1 < 2: 1 | 0", "1");
ET("if 1 < 0: 1 | 0", "0");

// Assert

ET("assert 2<3 | 1", "1");
ET("assert 2>3 | 1", '(VErr "Stop")');

// Let

ET("x = 1 | x + 2", "3");
ET("x = 1 | x := 2 | x + 2", "4");
ET("x = 1 | x += 2 | x + 2", "5");
ET("x = 1 | x = 2 | x | ", '(VErr "Shadow:x")');
ET("x := 1 | x | ", '(VErr "Undefined:x")');
ET("x = [1,2] | x[0] := 3 | x", "[3, 2]");
ET("x = [1,2] | x[0] += 3 | x", "[4, 2]");
ET('x = {a:[1]} | x["a"][1] := 2 | x', '{a: [1, 2]}');

// Loop

ET([ 'x = 1',
     'loop while x < 10:',
     '  x *= 2',
     'x',
    ],
   '16');

// Match

ET([
    'match 1:',
    '   2 => 3',
    '   x => x',
], '1');

ET([
    'match 2:',
    '   2 => 3',
    '   x => x',
], '3');

ET([
    'match [1,2]:',
    '     [2, x] => 1',
    '     [1, x] => x',
    '     _ => 9',
], '2');

// Classes & Objects

ET(['S = NewClass({a:1, b:1})',
    's = S.new(2, 3)',
    '[ S.match(s, (a,b) -> a+b, () -> 9),',
    '  S.match(0, (a,b) -> a+b, () -> 9) ]'
   ],
   '[5, 9]');

// Examples

let fibr = [
    '',
    '_fib = (_self, n) ->',
    '    fib = n2 -> _self(_self, n2)',
    '    if n <= 1: 0',
    '    if n == 2: 1',
    '    fib(n - 1) + fib(n - 2)',
    '',
    'fib = n -> _fib(_fib, n)',
    '',
    'fib(8)',
    '',
];

ET(fibr, "13")

let fibloop = [
    '',
    'fib = n ->',
    '    a = [0, 1]',
    '    loop while n > 1:',
    '        a := [a[1], a[0]+a[1]]',
    '        n := n-1',
    '    a[0]',
    '',
    'fib(8)',
    '',
];

ET(fibloop, "13");
