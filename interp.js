import {eq, eqAt, serialize, assert, fail, printf} from "./test.js";
import {clone, override, map, set, L, N} from "./misc.js";
import {astFmt, astFmtV, parseModule} from "./syntax.js";
import {Env, ilFmt} from "./desugar.js";

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
let VFun = (env, body) => N("VFun", env, body);

// Construct a native function value
let VNat = (fn) => N("VNat", fn);

// Construct an error value
let VErr = (desc, what) => N("VErr", desc, what);

let verrIf = (cond, desc, what) =>
    cond && VErr(desc, what);

let vassertType = (type, what) =>
    (valueType(what) !== type) && VErr("Expected " + type, what);

let evalIL = (node, stack, ctors) => {
    let ee = e => evalIL(e, stack, ctors);
    let value;

    if (node.T == "IVal") {
        let [ty, arg] = node;
        value = ctors(ty, arg);
    } else if (node.T == "IArg") {
        let [ups, pos] = node;
        let frame = stackGet(stack, ups);
        assert(frame !== undefined && frame[pos] !== undefined);
        value = frame[pos];
    } else if (node.T == "IFun") {
        let [body] = node;
        value = VFun(stack, body);
    } else if (node.T == "IApp") {
        let [fn, args] = node;
        let fnResult = ee(fn);
        let argResults = args.map(ee);
        if (fnResult.T == "VFun") {
            let [fstack, body] = fnResult;
            value = evalIL(body, stackPush(fstack, argResults), ctors);
        } else if (fnResult.T == "VNat") {
            let [fnNative] = fnResult;
            value = fnNative(...argResults);
        } else {
            value = VErr("NotAFunction", fnResult);
        }
    } else if (node.T == "IErr") {
        let [desc] = node;
        value = VErr(desc, null);
    } else {
        fail("Unsupported: %q", node);
    }
    if (value.T == "VErr") {
        let err = new Error(value);
        err.value = value;
        throw err;
    }
    return value;
};

let trapEval = (node, stack, ctors) => {
    let value;
    try {
        value = evalIL(node, stack, ctors);
    } catch (err) {
        if (err.value) {
            // This represents an error in the Rio program, not an error in
            // the interpreter.
            return err.value;
        } else {
            throw err;
        }
    };
    return value;
};

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
            assert(frame !== undefined && frame[pos] !== undefined);
            this.push(frame[pos]);
        } else if (node.T == "IFun") {
            let [body] = node;
            this.push(VFun(this.stack, body));
        } else if (node.T == "IApp") {
            let [fn, args] = node;
            this.tasks.push(N("_call", this.values.length));
            for (let n = args.length-1; n >= 0; --n) {
                this.tasks.push(args[n]);
            }
            this.tasks.push(fn);
        } else if (node.T == "_call") {
            let [idx] = node;
            let fn = this.values[idx];
            let args = this.values.slice(idx + 1);
            this.values = this.values.slice(0, idx);
            if (fn.T == "VFun") {
                let [fstack, body] = fn;
                this.tasks.push(N("_ret", this.stack));
                this.stack = stackPush(fstack, args);
                this.tasks.push(body);
            } else if (fn.T == "VNat") {
                let [fnNative] = fn;
                this.push(fnNative(...args));
            } else {
                this.push(VErr("NotAFunction", fn));
            }
        } else if (node.T == "_ret") {
            let [stack] = node;
            this.stack = stack;
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

// A Rio built-in Value can be one of:
//
//    VBool = <boolean>           Boolean
//    VNum = <number>             Number
//    VStr = <string>             String
//    (VVec value...)             Vector
//    (VRec {name, value}...)     Record
//    (VFun stack params body)    Function
//    (VErr code value)           Error
//
// name: string
// code: string
// where: ASTNode | null
// what: Value
// all others: Value
//
// VErr is a fatal error or exception.  It is never passed to a
// Rio function; when returned by a native function, it causes
// the interpreter loop to terminate.

// Format a value as Rio source text that produces that value (except for
// functions)
//
function valueFmt(value) {
    if (typeof value == "string") {
        return serialize(value);
    } else if (!(value instanceof Array)) {
        return String(value);
    }

    if (value.T == "VVec") {
        return '[' + value.map(valueFmt).join(', ') + ']';
    } else if (value.T == "VRec") {
        let fmtPair = ([key, value]) => key + ": " + valueFmt(value);
        return '{' + value.map(fmtPair).join(', ') + '}';
    } else if (value.T == "VFun") {
        let [fstack, body] = value;
        return '(...) -> ' + ilFmt(body);
    } else if (value.T == "VErr") {
        return "(VErr " + astFmtV(value) + ")";
    }
}

function valueType(value) {
    return (typeof value == 'string' ? 'VStr' :
            typeof value == 'number' ? 'VNum' :
            typeof value == 'boolean' ? 'VBool' :
            typeof (value ?? undefined) == 'object' ? value.T :
            fail('BadValue:' + (value === null ? 'null' : typeof(value))));
}

// A type's "behavior" is a function that obtains properties of its values:
//   (value, propertyName) -> propertyValue
//
let behaviors = Object.create(null);

let getProp = (value, name) => {
    let gp = behaviors[valueType(value)];
    return gp(value, name);
};

let baseBehavior = (value, name) =>
    VErr("UnknownProperty:" + name, value);

// Wrap a function operating on two values with a function suitable as a
// native function for use with makeMethodProp.
//
function wrapBinop(typeName) {
    return function (fn) {
        return function(a, args) {
            // The surface language calling convention, used to call the
            // method, puts its argument in a vector (arg bundle).
            let [b] = args;
            return vassertType(typeName, b)
                || fn(a, b);
        }
    }
}

// Construct a binary operator property: a function that takes one argument
// and calls `nativeMethod` with (self, arg).
//
// nativeMethod: (self, args) -> value
// result: (value) -> VFun that calls `nativeMethod` with `value` and its arg
//
function makeMethodProp(nativeMethod) {
    return function (value) {
        return VNat( (...args) => nativeMethod(value, args));
    }
}

// Construct a behavior from a map of property names to functions that
// construct properties.
//
function behaviorFn(propCtors, base) {
    base = base || baseBehavior;
    return function(value, name) {
        let pfn = propCtors[name];
        if (pfn) {
            return pfn(value);
        }
        return base(value, name);
    }
}

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
function makeBehavior(unops, binops, methods, typeName, base) {
    let nativeMethods = map(binops, wrapBinop(typeName));
    override(nativeMethods, methods);

    let propCtors = map(nativeMethods, makeMethodProp);
    override(propCtors, unops);
    return behaviorFn(propCtors, base);
}

//==============================
// VFun (exclusively constructed by `eval`...)
//==============================

behaviors.VFun = (value, name) => {
    return baseBehavior(value, name);
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
    "switch": (self, args) =>
        args.length == 2
        ? (self ? args[0] : args[1])
        : VErr("SwitchArity", args[3]),
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
    slice: (self, args) => {
        let [start, limit] = args;
        return vassertType("VNum", start)
            || vassertType("VNum", limit)
            || verrIf(start < 0 || start >= self.length, "Bounds", start)
            || verrIf(limit < start || limit >= self.length, "Bounds", start)
            || self.slice(start, limit);
    },

    "@[]": (self, args) => {
        let [offset] = args;
        return vassertType("VNum", offset)
            || verrIf(offset < 0 || offset >= self.length, "Bounds", offset)
            || self.charCodeAt(offset);
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

// Construct a VNum or VStr
//
function newValue(nativeValue) {
    if (typeof nativeValue === "number") {
        return nativeValue;
    } else {
        return String(nativeValue);
    }
}

//==============================
// VVec
//==============================

let vecUnops = {
    len: (v) => v.length,
};

let vecBinops = {
    "@++": (a, b) => {
        let o = clone(a);
        return move(b, 1, b.length, o.length+1, o);
    },
};

let vecMethods = {
    slice: (self, args) => {
        let [start, limit] = args;
        return vassertType("VNum", start)
            || vassertType("VNum", limit)
            || verrIf(start < 0 || start >= self.length, "Bounds", start)
            || verrIf(limit < start || limit >= self.length, "Bounds", start)
            || N("VVec", ...self.slice(start, limit));
    },

    set: (self, args) => {
        let [index, value] = args;
        return vassertType("VNum", index)
            // enforce contiguity (growable, but one at a time)
            || verrIf(index < 0 || index > self.length, "Bounds", index)
            || set(self, index, value);
    },

    "@[]": (self, args) => {
        let [offset] = args;
        return vassertType("VNum", offset)
            || verrIf(offset < 0 || offset >= self.length, "Bounds", offset)
            || self[offset];
    },
};

behaviors.VVec = makeBehavior(vecUnops, vecBinops, vecMethods, "VVec");

let vvecNew = (...args) => {
    return N("VVec", ...args);
};

// Note different calling convention than `@[]`.
//
let vvecNth = (self, n) =>
    vassertType("VVec", self)
    || vassertType("VNum", n)
    || verrIf(n < 0 || n >= self.length, "Bounds", self)
    || self[n];

// tests
//
let tv1 = vvecNew(newValue(9), newValue(8));
eq(tv1, N("VVec", 9, 8));
eq(vvecNth(tv1, newValue(0)), newValue(9));

//==============================
// VRec
//==============================

let vrecEmpty = N("VRec");

function recFindPair(rec, name) {
    for (let [index, pair] of rec.entries()) {
        if (pair[0] === name) {
            return index;
        }
    }
}

let recBinops = {
};

let recMethods = {
    setProp: (self, args) => {
        let [name, value] = args;
        return vassertType("VStr", name)
            || set(self, (recFindPair(self, name) ?? self.length),
                   [name, value]);
    },
};

let recBase = makeBehavior({}, recBinops, recMethods, "VRec");

behaviors.VRec = function (value, name) {
    let ndx = recFindPair(value, name);
    return ndx === undefined
        ? recBase(value, name)
        : value[ndx][1];
};

let vrecNew = (...names) => (...values) => {
    let v = set([], "T", "VRec");
    for (let ii of names.keys()) {
        v[ii] = [names[ii], values[ii]];
    }
    return v;
};

// vrecDef: names -> values -> record
let vrecDef = (...names) => VNat(vrecNew(...names));

//----------------
// tests
//----------------

let rval = vrecNew("a", "b")(1, 2);
eq(0, recFindPair(rval, "a"))
eq(1, recFindPair(rval, "b"))
eq(undefined, recFindPair(rval, "x"))
eq(behaviors.VRec(rval, "b"), 2);
let rv2 = recMethods.setProp(rval, ["b", 7]);
eq(behaviors.VRec(rv2, "b"), 7);

//==============================
// Store names of native functions for debugging
//==============================

let stop = () => VErr("Stop", null);

let builtins = {
    "vecNew": VNat(vvecNew),
    "recDef": VNat(vrecDef),
    "stop": VNat(stop),
    "getProp": VNat(getProp),
};

let builtinCtors = (type, arg) => {
    if (type == "Lib") {
        assert(builtins[arg]);
        return builtins[arg];
    } else if (type == "String") {
        return String(arg);
    } else if (type == "Number") {
        // use native type for numbers
        return Number(arg);
    } else {
        fail("Unexpected IVal type");
    }
};

let manifestVars = {
    "true": true,
    "false": false,
};

let [manifestEnv, manifestStack] = makeManifest(manifestVars);

//==============================================================
// Tests
//==============================================================

function trapEvalAST(ast) {
    // create `env` and `stack` for manifest
    return trapEval(manifestEnv.desugar(ast), manifestStack, builtinCtors);
}

let syncEvalAST = (ast) => {
    let il = manifestEnv.desugar(ast);
    return new Eval(il, manifestStack, builtinCtors).sync();
};

let ET = (source, valueOut, oobOut) => {
    //printf("ET: %s\n", valueOut);
    source = L(source).replace(/ \| /g, "\n");
    let [ast, oob] = parseModule(source);
    eqAt(2, "OOB: " + (oobOut || ""), "OOB: " + astFmtV(oob || []));
    eqAt(2, valueFmt(trapEvalAST(ast)), valueOut);
    eqAt(2, valueFmt(syncEvalAST(ast)), valueOut);
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

// ... Record
ET("{a:1}.a", "1");
ET('{a:1}.setProp("b",2).setProp("a",3)', "{a: 3, b: 2}");

// If

ET("if 1 < 2: 1 | 0", "1");
ET("if 1 < 0: 1 | 0", "0");

// Assert

ET("assert 2<3 | 1", "1");
ET("assert 2>3 | 1", '(VErr "Stop" null)');

// Let

ET("x = 1 | x + 2", "3");
ET("x = 1 | x := 2 | x + 2 | ", "4");
ET("x = 1 | x += 2 | x + 2 | ", "5");
ET("x = 1 | x = 2 | x | ", '(VErr "Shadow:x" null)');
ET("x := 1 | x | ", '(VErr "Undefined:x" null)');
ET("x = [1,2] | x[0] := 3 | x | ", "[3, 2]");
ET("x = [1,2] | x[0] += 3 | x | ", "[4, 2]");
ET("x = {a:[1]} | x.a[1] := 2 | x", "{a: [1, 2]}");

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
