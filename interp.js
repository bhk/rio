let test = require("test");
let {clone, override, map, set, L, N} = require("misc");
let {astFmt, astFmtV, parseModule} = require("syntax");
let {Env, ilFmt} = require("desugar");

//==============================================================
// Contexts
//==============================================================

// A context, as used in `eval`, is simply a stack of values.  The last
// element is the argument passed to the current function. The previous
// element is the argument passed to the parent function (when it
// constructed the current function).  And so on...

let emptyCxt = [];

function cxtBind(cxt, arg) {
    return [arg, ...cxt];
}

function cxtArg(cxt, index) {
    return cxt[index];
}

// Construct env & cxt from a set of manifest variables
//
function makeManifest(vars) {
    let names = Object.keys(vars).sort();
    let values = names.map(k => vars[k]);
    let env = new Env(names);
    let cxt = cxtBind(emptyCxt, values);
    return [env, cxt];
}

{
    let te = new Env(['a']);
    test.eq('1', ilFmt(te.desugar(N("Number", "1"))));
    test.eq('$0:0', ilFmt(te.desugar(N("Name", "a"))));
}

//==============================================================
// eval
//==============================================================

let VFun = (env, body) => N("VFun", env, body);
let VNat = (fn) => N("VNat", fn);

function eval(expr, cxt, ctors) {
    let typ = expr.T;
    let ee = e => eval(e, cxt, ctors);

    if (typ == "IVal") {
        let [ty, arg] = expr;
        return ctors(ty, arg);
    } else if (typ == "IArg") {
        let [ups, pos] = expr;
        let frame = cxtArg(cxt, ups);
        test.assert(frame !== undefined && frame[pos] !== undefined);
        return frame[pos];
    } else if (typ == "IFun") {
        let [body] = expr;
        return VFun(cxt, body);
    } else if (typ == "IApp") {
        let [fn, args] = expr;
        let fnResult = ee(fn);
        let argResults = args.map(ee);
        if (fnResult.T == "VFun") {
            let [fcxt, body] = fnResult;
            return eval(body, cxtBind(fcxt, argResults), ctors);
        } else if (fnResult.T == "VNat") {
            let [fnNative] = fnResult;
            return fnNative(...argResults);
        } else {
            throw new Error("Fault: call non-function");
        }
    } else {
        test.fail("Unsupported: %q", expr);
    }
}

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
//    (VFun cxt params body)      Function
//    (VErr code where what)
//
// name: string
// code: string
// where: ASTNode | null
// what: Value
// all others: Value
//
// VErr is a pseudo-value: never passed to functions or otherwise used in
// `eval`, it is passed to `error()`, and then returned from `trapEval`, to
// indicate that a fault was encountered.

// Format a value as Rio source text that produces that value (except for
// functions)
//
function valueFmt(value) {
    if (typeof value == "string") {
        return test.serialize(value);
    } else if (!(value instanceof Array)) {
        return String(value);
    }

    if (value.T == "VVec") {
        return '[' + value.map(valueFmt).join(', ') + ']';
    } else if (value.T == "VRec") {
        let fmtPair = ([key, value]) => key + ": " + valueFmt(value);
        return '{' + value.map(fmtPair).join(', ') + '}';
    } else if (value.T == "VFun") {
        let [fcxt, body] = value;
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
            test.fail('BadValue:' + (value === null ? 'null' : typeof(value))));
}

// A type's "behavior" is a function that obtains properties of its values:
//   (value, propertyName) -> propertyValue
//
let behaviors = Object.create(null);

let getProp = (value, name) => {
    let gp = behaviors[valueType(value)];
    return gp(value, name);
};

// faultIf() is called from native functions in the context of an
// evaluation.
//
//   what = offending value
//   where = AST node at which the error occurred
//
// TODO: Resolve confusion of use cases.  At run time we can identify a
// (Rio) value and not an AST node (e.g. in a native function).  At
// translation time (e.g. in desugarC) we can identify an AST node and some
// other (non-Rio) value.
//
function faultIf(cond, typ, what, where) {
    if (cond) {
        let err = new Error("Fault: " + typ);
        err.fault = N("VErr", typ, what ?? null, where ?? null);
        throw err;
    }
}

function assertType(value, type, where) {
    faultIf(valueType(value) !== type, "Expected_" + type, value, where);
}

function baseBehavior(value, name) {
    faultIf(true, "UnknownProperty:" + name, value);
}

// Wrap a function operating on two values with a function suitable as a
// native function for use with makeMethodProp.
//
function wrapBinop(typeName) {
    return function (fn) {
        return function(a, args) {
            // The surface language calling convention, used to call the
            // method, puts its argument in a vector (arg bundle).
            let [b] = args;
            assertType(b, typeName);
            return fn(a, b);
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
    "switch": (self, args) => {
        faultIf(args.length !== 2, "SwitchArity", args[3])
        return self ? args[0] : args[1];
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
    slice: (self, args) => {
        let [start, limit] = args;
        assertType(start, "VNum");
        assertType(limit, "VNum");
        faultIf(start < 0 || start >= self.length, "Bounds", start);
        faultIf(limit < start || limit >= self.length, "Bounds", start);
        return self.slice(start, limit);
    },

    "@[]": (self, args) => {
        let [offset] = args;
        assertType(offset, "VNum");
        faultIf(offset < 0 || offset >= self.length, "Bounds", offset);
        return self.charCodeAt(offset);
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
        assertType(start, "VNum");
        assertType(limit, "VNum");
        faultIf(start < 0 || start >= self.length, "Bounds", start);
        faultIf(limit < start || limit >= self.length, "Bounds", start);
        return N("VVec", ...self.slice(start, limit));
    },

    set: (self, args) => {
        let [index, value] = args;
        assertType(index, "VNum");
        // enforce contiguity (growable, but one at a time)
        faultIf(index < 0 || index > self.length, "Bounds", index);
        return set(self, index, value);
    },

    "@[]": (self, args) => {
        let [offset] = args;
        assertType(offset, "VNum");
        faultIf(offset < 0 || offset >= self.length, "Bounds", offset);
        return self[offset];
    },
};

behaviors.VVec = makeBehavior(vecUnops, vecBinops, vecMethods, "VVec");

let vvecNew = (...args) => {
    return N("VVec", ...args);
};

// Note different calling convention than `@[]`.
//
let vvecNth = (self, n) => {
    assertType(self, "VVec");
    assertType(n, "VNum");
    faultIf(n < 0 || n >= self.length, "Bounds", self);
    return self[n];
}

// tests
//
let tv1 = vvecNew(newValue(9), newValue(8));
test.eq(tv1, N("VVec", 9, 8));
test.eq(vvecNth(tv1, newValue(0)), newValue(9));

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
        assertType(name, "VStr");
        let ndx = recFindPair(self, name) ?? self.length;
        return set(self, ndx, [name, value]);
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
test.eq(0, recFindPair(rval, "a"))
test.eq(1, recFindPair(rval, "b"))
test.eq(undefined, recFindPair(rval, "x"))
test.eq(behaviors.VRec(rval, "b"), 2);
let rv2 = recMethods.setProp(rval, ["b", 7]);
test.eq(behaviors.VRec(rv2, "b"), 7);

//==============================
// Store names of native functions for debugging
//==============================

let stop = () => {
    faultIf(true, "Stop");
}

let builtins = {
    "vecNew": VNat(vvecNew),
    "recDef": VNat(vrecDef),
    "stop": VNat(stop),
    "getProp": VNat(getProp),
};

let builtinCtors = (type, arg) => {
    if (type == "Lib") {
        test.assert(builtins[arg]);
        return builtins[arg];
    } else if (type == "String") {
        return String(arg);
    } else if (type == "Number") {
        // use native type for numbers
        return Number(arg);
    } else {
        // TODO: return "Error" value, or stop?
    }
};

let manifestVars = {
    "true": true,
    "false": false,
};

let [manifestEnv, manifestCxt] = makeManifest(manifestVars);

function evalAST(ast) {
    // create `env` and `cxt` for manifest
    return eval(manifestEnv.desugar(ast), manifestCxt, builtinCtors);
}

//==============================================================
// Tests
//==============================================================

function trapEval(fn, ...args) {
    let value;
    try {
        value = fn(...args);
    } catch (err) {
        if (err.fault) {
            // This represents an error in the Rio program, not an error in
            // the interpreter.
            // test.printf("Fault:\n%s\n", err.stack);
            return err.fault;
        }
        throw err;
    };
    return value;
}

function et(source, evalue, eoob) {
    source = L(source).replace(/ \| /g, "\n");
    let [ast, oob] = parseModule(source);
    test.eqAt(2, "OOB: " + (eoob || ""), "OOB: " + astFmtV(oob || []));
    let val = trapEval(evalAST, ast);
    test.eqAt(2, evalue, valueFmt(val));
}

// manifest variables

et("true", 'true');

// parse error

et(".5", "0.5", '(Error "NumDigitBefore")');

// eval error

// TODO: error --> IErr --> VErr
// et("x", '(VErr "Undefined" "x" null)');

// literals and constructors

et("1.23", "1.23");
et('"abc"', '"abc"');
et("[1,2,3]", "[1, 2, 3]");
et("{a: 1, b: 2}", "{a: 1, b: 2}");

// Fn

et("x -> x", '(...) -> $0:0');

// Function calls

et("(x -> x)(2)", "2");
et("(x -> [x])(2)", "[2]");
et("(x -> [x]) $ 2", "[2]");

// operators and properties ...

// ... Boolean
et("not (1==1)", "false");
et("1==1 or 1==2", "true");
et("1==1 and 1==2", "false");
et("(1==1) != (1==2)", "true");
et("(2==2).switch(1,0)", "1");
et("(2==3).switch(1,0)", "0");

// ... Number
et("1 + 2", "3");
et("7 // 3", "2");
et("-(1)", "-1");
et("1 < 2", "true");
et("1 < 2 < 3", "true");

// ... String
et(' "abc" ++ "def" ', '"abcdef"');
et(' "abc".len ', '3');
et(' "abcd".slice(1, 3) ', '"bc"');
et(' "abc" == "abc" ', 'true');
et(' "abc"[1] ', '98');

// ... Vector
et("[7,8,9].len", "3");
et("[7,8,9][1]", "8");
et("[7,8,9,0].slice(1,3)", "[8, 9]");
et("[7,8,9,0].slice(1,1)", "[]");
et("[7,8,9].set(1, 2)", "[7, 2, 9]");

// ... Record
et("{a:1}.a", "1");
et('{a:1}.setProp("b",2).setProp("a",3)', "{a: 3, b: 2}");

// If

et("if 1 < 2: 1 | 0", "1");
et("if 1 < 0: 1 | 0", "0");

// Assert

et("assert 2<3 | 1", "1");
et("assert 2>3 | 1", '(VErr "Stop" null null)');

// Let

et("x = 1 | x + 2", "3");
et("x = 1 | x := 2 | x + 2 | ", "4");
et("x = 1 | x += 2 | x + 2 | ", "5");
// TODO: eliminate catch
//et("x = 1 | x = 2 | x | ", '(VErr "Shadow" "x" null)');
//et("x := 1 | x | ", '(VErr "Undefined" "x" null)');

et("x = [1,2] | x[0] := 3 | x | ", "[3, 2]");
et("x = [1,2] | x[0] += 3 | x | ", "[4, 2]");
et("x = {a:[1]} | x.a[1] := 2 | x", "{a: [1, 2]}");

// Loop

et([ 'x = 1',
     'loop while x < 10:',
     '  x *= 2',
     'x',
    ],
   '16');

// Match

et([
    'match 1:',
    '   2 => 3',
    '   x => x',
], '1');

et([
    'match 2:',
    '   2 => 3',
    '   x => x',
], '3');

et([
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

et(fibr, "13")

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

et(fibloop, "13");
