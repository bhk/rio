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

// Construct env & matching stack from a set of manifest variables
let makeManifest = (vars) => {
    let names = Object.keys(vars).sort();
    let values = names.map(k => vars[k]);
    let env = new Env(names);
    let stack = stackPush(emptyStack, values);
    return [env, stack];
};

//==============================================================
// eval
//==============================================================

// Construct an IL function value
let VFun = (stack, body) => ({T:"VFun", stack: stack, body: body});

// Construct a native function value
let VNat = (fn) => ({T:"VNat", fn: fn});

// Construct an error value
let VErr = (desc, what) => ({T:"VErr", desc: desc, what: what});

let verrIf = (cond, desc, what) =>
    cond && VErr(desc, what);

let vassertType = (type, what) =>
    (valueType(what) !== type) && VErr("Expected " + type, what);

// Eval
//
// tasks[] is an array of IL records or internal tasks (_call or _ret).
// values[] is an array of result values.
//
// The last element in tasks[] is the next todo entry to be processed when
// step() is called.  Processing an IL record pushes its result onto
// values[].  Processing an internal task performs intermediate steps
// required for processing an IApp.
//
class Eval {
    constructor(node, stack, ctors) {
        this.ctors = ctors;
        this.values = [];
        this.tasks = [node];
        this.stack = stack;
    }

    // Add a value to the end of values[]
    push(value) {
        if (value.T == "VErr") {
            this.tasks = [];
            this.values = [];
        }
        this.values.push(value);
    }

    // Returns result value, or `undefined` if still pending
    step() {
        let node = this.tasks.pop();
        //logf("V: %q\n", this.values);
        //logf("T: %q @ %s\n", node, this.tasks.length);

        if (node == undefined) {
            return this.values[0];
        } else if (node.T == "IVal") {
            let [ty, arg] = node;
            this.push(this.ctors(ty, arg));
        } else if (node.T == "IArg") {
            let [ups, pos] = node;
            let frame = stackGet(this.stack, ups);
            if (!frame || !frame[pos]) {
                printf("node = %q\nstack = %q\n", node, this.stack);
            }
            assert(frame !== undefined && frame[pos] !== undefined);
            this.push(frame[pos]);
        } else if (node.T == "IFun") {
            let [body] = node;
            this.push(VFun(this.stack, body));
        } else if (node.T == "IApp") {
            let [fn, args] = node;
            this.tasks.push({T:"_call", idx: this.values.length});
            for (let n = args.length-1; n >= 0; --n) {
                this.tasks.push(args[n]);
            }
            this.tasks.push(fn);
        } else if (node.T == "_call") {
            let idx = node.idx;
            let fn = this.values[idx];
            let args = this.values.slice(idx + 1);
            this.values = this.values.slice(0, idx);
            if (fn.T == "VFun") {
                this.tasks.push({T:"_ret", stack: this.stack});
                this.stack = stackPush(fn.stack, args);
                this.tasks.push(fn.body);
            } else if (fn.T == "VNat") {
                let fnNative = fn.fn;
                this.push(fnNative(...args));
            } else {
                this.push(VErr("NotAFunction", fn));
            }
        } else if (node.T == "_ret") {
            this.stack = node.stack;
        } else if (node.T == "IErr") {
            let [desc] = node;
            this.push(VErr(desc, null));
        } else {
            fail("Unsupported: %q", node);
        }
    }

    sync() {
        while (this.step() == undefined) {}
        return this.step();
    }
};

//==============================================================
// Built-In Types
//==============================================================

// A Rio built-in Value is a JS object with T: TYPE, where TYPE
// is one of: VBool, VNum, VStr, VMap, VObj, VFun, VNat, VErr.
//
// VErr is a fatal error or exception.  It is never passed to a
// Rio function; when returned by a native function, it causes
// the interpreter loop to terminate.

let VBool = (b) => ({T:"VBool", v: b});  // `v` => native value
let VNum = (n) => ({T:"VNum", v: n});
let VStr = (s) => ({T:"VStr", v: s});
let VVec = (a) => ({T:"VVec", v: a});
let VMap = (p) => ({T:"VMap", pairs: p});
let VObj = (cls, values) => ({T:"VObj", cls, values});

// Construct a Value record from its native (JS) type
let box = (value) =>
    typeof value == "boolean" ? VBool(value) :
    typeof value == "string" ? VStr(value) :
    typeof value == "number" ? VNum(value) :
    value instanceof Array ? VVec(value) :
    value.T ? value :
    fail("box: unknown value");

// Recover native (JS) type from a Value (if othere is one)
let unbox = (value) =>
    (value.T && value.v !== undefined) ? value.v :
    value.T == "VMap" ? value :
    fail("unbox: unknown value");

eq({T:"VBool", v:false}, box(false));
eq(false, unbox(box(false)));
eq(1, unbox(box(1)));
eq("a", unbox(box("a")));

// Format a value as Rio source text that produces that value (except for
// functions)
//
let valueFmt = (value) => {
    if (value.T == "VBool") {
        return String(value.v);
    } else if (value.T == "VNum") {
        return String(value.v);
    } else if (value.T == "VStr") {
        return '"' + value.v + '"';
    } else if (value.T == "VVec") {
        let a = value.v;
        return '[' + a.map(valueFmt).join(', ') + ']';
    } else if (value.T == "VMap") {
        let fmtPair = ([key, value]) => key + ": " + valueFmt(value);
        return '{' + value.pairs.map(fmtPair).join(', ') + '}';
    } else if (value.T == "VFun") {
        return '(...) -> ' + IL.fmt(value.body);
    } else if (value.T == "VErr") {
        return "(VErr " + astFmt(value.desc) + " " + astFmt(value.what) + ")";
    } else if (value.T == "VObj") {
        let members = value.cls.fields.map(
            (name, idx) => name + ":" + valueFmt(value.values[idx])
        ).join(" ");
        return "(VObj " + members + ")";
    } else if (value.T == "VCls") {
        return "(VCls " + value.fields.join(" ") + ")";
    } else {
        return "UnknownValue: " + serialize(value);
    }
};

let valueType = (value) => {
    return (typeof (value ?? undefined) == 'object' ? value.T :
            fail('BadValue:' + (value === null ? 'null' : typeof(value))));
};

// A type's "behavior" is a function that obtains properties of its values:
//   (value, propertyName) -> propertyValue
//
let behaviors = Object.create(null);

let getProp = (value, name) => {
    let gp = behaviors[valueType(value)];
    return gp(value, name);
};

let unknownProperty = (value, name) =>
    VErr("UnknownProperty:" + name, value);


// Wrap a "native" binop function with a VNat-suitable function.
// as a "Lib" function.
//
let wrapBinop = (typeName) => (fn) => (a, args) => {
    // The surface language calling convention, used to call the
    // method, puts its argument in a vector (arg bundle).
    let [b] = args;
    return vassertType(typeName, b)
        || box(fn(unbox(a), unbox(b)));
};

let wrapUnop = (fn) => (v) => box(fn(unbox(v)));

// Construct a binary operator property: a function that takes one argument
// and calls `nativeMethod` with (self, arg).
//
// nativeMethod: (self, args) -> value
// result: (value) -> VFun that calls `nativeMethod` with `value` and its arg
//
let makeMethodProp = (nativeMethod) => (value) =>
    VNat( (...args) => nativeMethod(value, args));

// Construct a behavior from a map of property names to functions that
// construct properties.
//
let behaviorFn = (propCtors, base) => {
    base = base || unknownProperty;
    return (value, vname) => {
        let name = unbox(vname);
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
        let self = unbox(vself);
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
        let self = unbox(vself);
        let start = unbox(vstart);
        let limit = unbox(vlimit);
        return vassertType("VNum", vstart)
            || vassertType("VNum", vlimit)
            || verrIf(start < 0 || start >= self.length, "Bounds", start)
            || verrIf(limit < start || limit >= self.length, "Bounds", start)
            || box(self.slice(start, limit));
    },

    "@[]": (vself, args) => {
        let [voffset] = args;
        let self = unbox(vself);
        let offset = unbox(voffset);
        return vassertType("VNum", voffset)
            || verrIf(offset < 0 || offset >= self.length, "Bounds", offset)
            || box(self.charCodeAt(offset));
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
        let self = unbox(vself);
        let [vstart, vlimit] = args;
        let start = unbox(vstart);
        let limit = unbox(vlimit);
        return vassertType("VNum", vstart)
            || vassertType("VNum", vlimit)
            || verrIf(start < 0 || start >= self.length, "Bounds", vstart)
            || verrIf(limit < start || limit >= self.length, "Bounds", vstart)
            || box(self.slice(start, limit));
    },

    set: (vself, args) => {
        let self = unbox(vself);
        let [vindex, value] = args;
        let index = unbox(vindex);
        return vassertType("VNum", vindex)
            // enforce contiguity (growable, but one at a time)
            || verrIf(index < 0 || index > self.length, "Bounds", vindex)
            || box(set(self, index, value));
    },

    "@[]": (vself, args) => {
        let self = unbox(vself);
        let [voffset] = args;
        let offset = unbox(voffset);
        return vassertType("VNum", voffset)
            || verrIf(offset < 0 || offset >= self.length, "Bounds", offset)
            || box(self[offset]);
    },
};

behaviors.VVec = makeBehavior(vecUnops, vecBinops, vecMethods, "VVec");

let vvecNew = (...args) => VVec(args);

// Note different calling convention than `@[]`.
//
let vvecNth = (vself, vn) => {
    let self = unbox(vself);
    let n = unbox(vn);
    return vassertType("VVec", vself)
        || vassertType("VNum", vn)
        || verrIf(n < 0 || n >= self.length, "Bounds", self)
        || box(self[n]);
};

// tests
//
let tv1 = vvecNew(box(9), box(8));
eq(tv1, VVec([box(9), box(8)]));
eq(unbox(vvecNth(tv1, box(0))), 9);

//==============================
// VMap
//==============================

let pairsFind = (pairs, name) => {
    for (let [index, pair] of pairs.entries()) {
        if (pair[0] === name) {
            return index;
        }
    }
}

let mapBinops = {
};

let mapMethods = {
    set: (vself, args) => {
        let [vname, value] = args;
        let pairs = vself.pairs;
        let name = unbox(vname);
        return vassertType("VStr", vname)
            || VMap(set(pairs, (pairsFind(pairs, name) ?? pairs.length),
                        [name, value]));
    },

    "@[]": (vself, args) => {
        let [vkey] = args;
        let pairs = vself.pairs;
        let index = pairsFind(pairs, unbox(vkey));
        return vassertType("VStr", vkey)
            || verrIf(index == undefined, "NotFound", vkey)
            || box(pairs[index][1]);
    },
};

let mapBase = makeBehavior({}, mapBinops, mapMethods, "VMap");

behaviors.VMap = (vself, vname) => {
    let name = unbox(vname);  // TODO: assert string?
    let pairs = vself.pairs;
    let ndx = pairsFind(pairs, name);
    return ndx === undefined
        ? mapBase(vself, vname)
        : pairs[ndx][1];
};

let vmapNew = (...names) => (...values) => {
    let pairs = [];
    for (let ii of names.keys()) {
        let key = unbox(names[ii]);        // TODO: assert string?
        pairs[ii] = [key, values[ii]];
    }
    return VMap(pairs);
};

// vmapDef: names -> values -> map
let vmapDef = (...names) => VNat(vmapNew(...names));

{
    // Test VMap
    let rval = vmapNew(box("a"), box("b"))(box(1), box(2));
    eq(0, pairsFind(rval.pairs, "a"));
    eq(1, pairsFind(rval.pairs, "b"));
    eq(undefined, pairsFind(rval.pairs, box("x")));
    eq(unbox(behaviors.VMap(rval, box("b"))), 2);
    let rv2 = mapMethods.set(rval, [box("b"), box(7)]);
    eq(unbox(behaviors.VMap(rv2, box("b"))), 7);
}

//==============================
// VObj & VCls
//==============================

let VCls = (fields) => ({T:"VCls", fields});

let objSetProp = (vself) => (vname, vvalue) => {
    let {cls, values} = vself;
    let name = unbox(vname);
    let index = cls.fields.indexOf(name);
    return vassertType("VStr", vname)
        || verrIf(index < 0, "Unknown", vname)
        || VObj(cls, set(values, index, value));
};

behaviors.VObj = (vself, vprop) => {
    let {cls, values} = vself;
    let prop = unbox(vprop);
    let index;
    return vassertType("VStr", vprop)
        || prop == "setProp" && objSetProp(vself)
        || verrIf((index = cls.fields.indexOf(prop)) < 0, "Unknown", vprop)
        || values[index];
};

// Class.new(...values) -> object
let VCls_new = (vself) => {
    let {fields} = vself;
    let ctor = (...values) => {
        assert(values.length == fields.length);
        return VObj(vself, values);
    };
    return VNat(ctor);
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
    VNat((value) => box(value.T == "VObj" && value.cls == vclass));

behaviors.VCls = (vself, vprop) => {
    let prop = unbox(vprop);
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
    // Test VObj & VCls
    let tmap = vmapNew(box("a"), box("b"))(box(true), box(true));
    let cls = NewClass(tmap);
    assert(cls.T == "VCls");

    // new()
    let vnew = getProp(cls, box("new"));
    assert(vnew.T == "VNat");
    let obj = vnew.fn(box(1), box(2));
    assert(obj.T == "VObj");
    eq(unbox(getProp(obj, VStr("a"))), 1);

    // matches()
    let vmatches = getProp(cls, box("matches"));
    assert(vmatches.T == "VNat");
    assert(unbox(vmatches.fn(obj)), true);

    // match()
    let vmatch = getProp(cls, box("match"));
    assert(vmatch.T == "VFun");
}

//==============================
// Store names of native functions for debugging
//==============================

let stop = () => VErr("Stop", null);

let builtins = {
    "vecNew": VNat(vvecNew),
    "mapDef": VNat(vmapDef),
    "stop": VNat(stop),
    "getProp": VNat(getProp),
};

let builtinCtors = (type, arg) => {
    if (type == "Lib") {
        assert(builtins[arg]);
        return builtins[arg];
    } else if (type == "String") {
        return box(String(arg));
    } else if (type == "Number") {
        // use native type for numbers
        return box(Number(arg));
    } else {
        fail("Unexpected IVal type");
    }
};

let manifestVars = {
    "true": VBool(true),
    "false": VBool(false),
    "NewClass": VNat(NewClass),
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

ET("x", '(VErr "Undefined:x" null)');

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
ET("assert 2>3 | 1", '(VErr "Stop" null)');

// Let

ET("x = 1 | x + 2", "3");
ET("x = 1 | x := 2 | x + 2", "4");
ET("x = 1 | x += 2 | x + 2", "5");
ET("x = 1 | x = 2 | x | ", '(VErr "Shadow:x" null)');
ET("x := 1 | x | ", '(VErr "Undefined:x" null)');
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
