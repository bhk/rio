// Rio interpreter

let test = require("test");
let {append, clone, override, map, set, sexprFormatter} = require("misc");
let {astFmt, astFmtV, parseModule} = require("syntax");

let N = (typ, ...elems) => {
    elems.T = typ;
    return elems;
};

//==============================================================
// desugar: Surface Language to Middle Language
//==============================================================
//
// This translation requires no knowledge of the enclosing scope.  Instead
// of translating an AST tree to an ML tree, we could construct the ML tree
// directly during parsing.  That would be more performant and simplify this
// code slightly, but it would complicate initialization/construction of the
// parser.
//
// The middle language retains surface language semantics but uses a reduced
// set of primitives.  Functions accept argument bundles, and values have
// properties.
//
//     (MVal nativevalue)
//     (MName name)
//     (MFun params mexpr sOK)
//     (MCall fn args)
//     (MProp value name)
//     (MLoop body k)
//     (MError desc ast)
//
// params: {string...}
// name: string
// nativevalue: string | number
//
// There is no notion of "native" functions in ML, but constructed
// expressions reference the following free variables:
//     .vecNew : values -> vector
//     .recDef : names -> values -> record

let mlFmt = sexprFormatter({
    MName: v => v[0],
});

function snameToString(ast) {
    test.assert(ast.T == "Name");
    return ast[0];
}

function mval(val) {
    return N("MVal", val);
}

function mname(str) {
    return N("MName", str);
}

function merror(code, ast) {
    return N("MError", code, ast);
}

function mlambda(params, body, shadowMode) {
    return N("MFun", params, body, shadowMode);
}

function mcall(mfn, margs) {
    return N("MCall", mfn, margs);
}

function mprop(mvalue, name) {
    return N("MProp", mvalue, name);
}

function mlet(name, value, expr, shadowMode) {
    return mcall(mlambda([name], expr, shadowMode), [value]);
}

function msend(value, name, args) {
    return mcall(mprop(value, name), args);
}

function mif(mcond, mthen, melse) {
    return mcall(msend(mcond, "switch", [mlambda([], mthen),
                                         mlambda([], melse)]),
                 []);
}

function mbinop(op, a, b) {
    return mcall(mprop(a, "{}" + op), [b]);
}

function mindex(vec, index) {
    return mbinop("[]", vec, index);
}

// Translate AST expression into Middle Language
//
function desugarExpr(ast) {
    let ds = desugarExpr;
    let typ = ast.T;

    if (typ == "Name") {
        return mname(ast[0]);
    } else if (typ == "Number") {
        return mval(Number(ast[0]));
    } else if (typ == "String") {
        return mval(ast[0])
    } else if (typ == "Fn") {
        let [params, body] = ast;
        return mlambda(params.map(snameToString), ds(body));
    } else if (typ =="Call") {
        let [fn, args] = ast;
        return mcall(ds(fn), args.map(ds));
    } else if (typ =="Dot") {
        let [a, b] = ast;
        return mprop(ds(a), snameToString(b));
    } else if (typ =="Index") {
        let [a, b] = ast;
        return mindex(ds(a), ds(b));
    } else if (typ =="Binop") {
        let [op, a, b] = ast;
        if (op == "$") {
            return mcall(ds(a), [ds(b)]);
        }
        return mbinop(op, ds(a), ds(b));
    } else if (typ == "Unop") {
        let [op, svalue] = ast;
        return mprop(ds(svalue), op);
    } else if (typ == "IIf") {
        let [c, a, b] = ast;
        return branch(ds(c), ds(a), ds(b));
    } else if (typ == "Vector") {
        let [elems] = ast;
        return mcall(mname(".vecNew"), elems.map(ds));
    } else if (typ == "Record") {
        let [rpairs] = ast;
        let keys = [];
        let values = [];
        for (let ii = 0; ii < rpairs.length; ii += 2) {
            keys.push( mval(snameToString(rpairs[ii])) );
            values.push( ds(rpairs[ii+1]) );
        }
        let recCons = mcall(mname(".recDef"), keys);
        return mcall(recCons, values);
    } else if (typ == "Match") {
        let [value, cases] = ast;
        let melse = merror("CaseNotHandled", ast);
        for (let c of cases.slice().reverse()) {
            if (c.T !== "S-Case") {
                return merror("ExpectedCase", c);
            }
            let [pattern, body] = c;
            let mbody = desugarExpr(body);
            melse = desugarCase(mname("$value"), pattern, mbody, melse);
        }
        return mlet("$value", ds(value), melse);
    } else if (typ == "Block") {
        let [lines] = ast;
        return desugarBlock(lines, 0);
    } else if (typ == "Missing") {
        return merror("MissingExpr", ast);
    } else {
        test.fail("Unknown AST: %s", astFmt(ast));
    }
}

function desugarCase(mvalue, pattern, mthen, melse) {
    let typ = pattern.T;
    if (typ == "Name") {
        let [name] = pattern;
        return mlet(name, mvalue, mthen, "=");
    } else if (typ == "Number" || typ == "String") {
        return mif(mbinop("==", desugarExpr(pattern), mvalue), mthen, melse);
    } else if (typ == "VecPattern") {
        let [elems] = pattern;
        let mfthen = mlambda([], mthen, null);
        for (let [index, elem] of elems.entries()) {
            mfthen = desugarCase(mindex(mvalue, mval(index)),
                                 elem,
                                 mfthen,
                                 mname("$felse"));
        }
        let mlenEQ = mbinop("==", mval(elems.length), mprop(mvalue, "len"));
        return mcall(mlet("$felse", mlambda([], melse, null),
                          mif(mlenEQ, mfthen, mname("$felse"))),
                     []);
    }
}

// Remove layers of `Dot` and `Index` operators from `target` until just a
// name remains; update `mvalue` correspondingly.
//
// Return: [target: AST, value: MLRecord]
//
function peelTarget(target, mvalue) {
    let ds = desugarExpr;
    if (target.T == "Name") {
        return [target, mvalue];
    } else if (target.T == "Index") {
        let [tgt, idx] = target;
        return peelTarget(tgt, msend(ds(tgt), "set", [ds(idx), mvalue]));
    } else if (target.T == "Dot") {
        let [tgt, sname] = target;
        let mname = mval(snameToString(sname));
        return peelTarget(tgt, msend(ds(tgt), "setProp", [mname, mvalue]));
    }
}

function desugarStmt(ast, k) {
    let typ = ast.T;
    if (typ == "S-If") {
        let [scond, sthen] = ast;
        return mif(desugarExpr(scond), desugarExpr(sthen), k);
    } else if (typ == "S-Let") {
        // operators:  =  :=  +=  *= ...
        let [target, op, svalue] = ast;
        let shadowMode = op == "=" ? "=" : ":=";
        let mvalue = desugarExpr(svalue);
        // handle +=, etc.
        let modop = op.match(/^[^:=]+/);
        if (modop != null) {
            mvalue = mbinop(modop[0], desugarExpr(target), mvalue);
        }
        [target, mvalue] = peelTarget(target, mvalue);
        return mlet(snameToString(target), mvalue, k, shadowMode);
    } else if (typ == "S-Loop") {
        let [block] = ast;
        let rep = N("Name", "repeat");
        return N("MLoop", desugarBlock(append(block, [rep]), 0), k);
    } else if (typ == "S-While") {
        let [cond] = ast;
        return mif(desugarExpr(cond), k, mname("break"));
    } else if (typ == "S-LoopWhile") {
        let [cond, block] = ast;
        return desugarStmt(N("S-Loop", append([N("S-While", cond)], block)), k);
    } else if (typ == "S-Assert") {
        let [cond] = ast;
        return mif(desugarExpr(cond), k, mcall(mname(".stop"), []));
    } else {
        test.fail("Unknown statement: %s", astFmt(ast));
    }
}

// Translate AST block into Middle Language, starting at index `ii`
//
function desugarBlock(lines, ii) {
    let k = lines[ii+1] && desugarBlock(lines, ii+1);
    let line = lines[ii];

    if (line.T.match(/^S\-/)) {
        return desugarStmt(line, k || merror("MissingFinalExpr", line));
    } else if (k != undefined) {
        // silently ignore extraneous expression
        return merror("Extraneous", line);
    }
    return desugarExpr(line);
}


//--------------------------------
// Tests
//--------------------------------


let parseToAST = (src) => parseModule(src)[0];

let L = (ary) => [...ary, ''].join('\n');

// Construct a let expression as serialized by mlFmt().
let fmtLet = (name, value, expr, shadowMode) => {
    let mode = shadowMode ? ' "' + shadowMode + '"' : "";
    return `(MCall (MFun ["${name}"] ${expr}${mode}) [${value}])`;
};

test.eq(mlFmt(desugarExpr(parseToAST("x"))), 'x');
test.eq(mlFmt(desugarExpr(parseToAST("x + 1\n"))),
        '(MCall (MProp x "{}+") [(MVal 1)])');

// peelTarget

let nameX = N("Name", "x");
let [nm, val] = peelTarget(nameX, mval(1));
test.eq(nameX, nm);
test.eq(mval(1), val);

[nm, val] = peelTarget(
    N("Dot", N("Index", nameX, N("Number", "1")), N("Name","a")),
    mval(9));
test.eq(nameX, nm);
test.eq(msend(mname("x"), "set",
              [mval(1), msend(msend(mname("x"), "{}[]", [mval(1)]),
                              "setProp",
                              [mval("a"), mval(9)])]),
        val);

// Assignment

test.eq(fmtLet('x', '(MVal 1)', 'x', '='),
        mlFmt(mlet('x', mval(1), mname('x'), '=')));

test.eq(fmtLet('x', '(MVal 1)', '(MCall (MProp x \"{}+\") [(MVal 2)])', '='),
        mlFmt(desugarExpr(parseToAST("x = 1\nx + 2\n"))));

// Loop

let loop0 = L([
    'loop:',
    '  x := 1',
    'x',
]);

test.eq('(MLoop (MCall (MFun ["x"] repeat ":=") [(MVal 1)]) x)',
        mlFmt(desugarExpr(parseToAST(loop0))));

test.eq(["x", "y", "z"],
        findLets(N("MCall",
                   N("MFun", ["x", "y"], N("MVal", null), true),
                   [N("MFun", ["z"], N("MVal", null), true)])));


//==============================================================
// Environments
//==============================================================

// An environment, as used in `eval`, is simply a stack of values.  The last
// element is the argument passed to the current function. The previous
// element is the argument passed to the parent function (when it
// constructed the current function).  And so on...

let emptyEnv = [];

function envBind(env, arg) {
    return [arg, ...env];
}

function envArg(env, index) {
    return env[index];
}

//==============================================================
// Inner Language
//==============================================================

// Inner Language nodes (IExpr's)
//   (IVal value)           // constant/literal value
//   (IArg index)           // argument reference
//   (IFun body)            // function construction (lambda)
//   (IApp fn arg)          // function application
//   (INat nfn args)        // native function call
//
// value : VNode
// index : (native) number
// nfn : (native) function
// all others : IExpr || [IExpr]

let nfnNames = Object.create(null);

let ilFmt = sexprFormatter({
    // $0 = argument to this function; $1 = argument to parent, ...
    IArg: (e) => "$" + e[0],
    // number, string
    IVal: (e) => valueFmt(e[0]),
    // Value[Value]     = vector index
    // @[Value]         = vector constructoio
    // (NativeFunc ...) = generic native function
    INat: (e, fmt) => {
        let [nfn, args] = e;
        let name = nfnNames[nfn];
        if (name == "vvecNth") {
            test.assert(args.length === 2);
            return fmt(args[0]) + '[' + fmt(args[1]) + ']';
        }
        let argValues = args.map(fmt).join(" ");
        if (name == "vvecNew") {
            return "@[" + argValues + "]";
        }
        return '(' + name + ' ' + argValues + ')';
    }
});

function eval(expr, env) {
    let typ = expr.T;
    let ee = e => eval(e, env);

    if (typ == "IVal") {
        return expr[0];
    } else if (typ == "IArg") {
        let [index] = expr;
        let value = envArg(env, index);
        test.assert(value !== null);
        return value;
    } else if (typ == "IFun") {
        let [body] = expr;
        return N("VFun", env, body);
    } else if (typ == "IApp") {
        let [fn, arg] = expr;
        let fnValue = ee(fn);
        faultIf(valueType(fnValue) !== "VFun", "NotFn", expr.ast, fnValue);
        let [fenv, body] = fnValue;
        return eval(body, envBind(fenv, ee(arg)));
    } else if (typ == "INat") {
        let [nfn, args] = expr;
        return nfn(...args.map(ee));
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
//    (VFun env params body)      Function
//    (VErr code where what)
//
// name: string
// code: string
// where: ASTNode or null
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
        let [fenv, body] = value;
        return '(...) -> ' + ilFmt(body);
    } else if (value.T == "VErr") {
        return "(VErr " + astFmtV(value) + ")";
    }
}

function valueType(value) {
    return typeof value == 'object'
        ? value.T
        : typeof value;
}

// `natives` contains functions that are called via CNat and used
// directly by `desugar`.
//
let natives = Object.create(null);

// A type's "behavior" is a function that obtains properties of its values:
//   (value, propertyName) -> propertyValue
//
let behaviors = Object.create(null);

natives.getProp = (value, name) => {
    let gp = behaviors[valueType(value)];
    return gp(value, name);
};

// faultIf() is called from native functions in the context of an
// evaluation.
//
function faultIf(cond, typ, where, what) {
    if (cond) {
        let err = new Error("Fault: " + typ);
        err.fault = N("VErr", typ, where || {}, what);
        throw err;
    }
}

function baseBehavior(value, name) {
    faultIf(true, "UnknownProperty:" + name, null, value);
}

// Wrap a Lua function operating on two values with a function suitable as a
// native function for use with makeMethodProp.
//
function wrapBinop(typeName) {
    return function (fn) {
        return function(a, args) {
            // The surface language calling convention, used to call the
            // method, puts its argument in a vector (arg bundle).
            let [b] = args;
            test.assert(b !== null);  // should not happen
            faultIf(valueType(b) !== typeName, "Not" + typeName, null, b);
            return fn(a, b);
        }
    }
}

// nativeMethod: (self, args) -> value
// result: (value) -> VFun that calls `nativeMethod` with `value` and its arg
//
function makeMethodProp(nativeMethod) {
    let body = N("INat", nativeMethod, [N("IArg", 1), N("IArg", 0)]);
    return function (value) {
        return N("VFun", envBind(emptyEnv, value), body);
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

    // record names of native functions for debugging
    for (let [name, nativeMethod] of Object.entries(nativeMethods)) {
        nfnNames[nativeMethod] = typeName + name;
    }

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
// VBool (happens to be Lua boolean)
//==============================

let boolUnops = {
    "not": (b) => !b,
};

let boolBinops = {
    "{}or": (a, b) => a || b,
    "{}and": (a, b) => a && b,
    "{}==": (a, b) => a == b,
    "{}!=": (a, b) => a !== b,
};

let boolMethods = {
    "switch": (self, args) => {
        faultIf(args.length !== 2, "SwitchArity", null, args[3])
        return self ? args[0] : args[1];
    },
};

behaviors.boolean = makeBehavior(boolUnops, boolBinops, boolMethods, "boolean");

//==============================
// VStr  (happens to be Lua string)
//==============================

let strUnops = {
    len: (v) => v.length,
};

// "Operators" operate on two values of the same type
let strBinops = {
    "{}<": (a, b) => a < b,
    "{}==": (a, b) => a == b,
    "{}!=": (a, b) => a !== b,
    "{}<=": (a, b) => a <= b,
    "{}<": (a, b) => a < b,
    "{}>=": (a, b) => a >= b,
    "{}>": (a, b) => a > b,
    "{}++": (a, b) => a + b,
};

let strMethods = {
    slice: (self, args) => {
        let [start, limit] = args;
        faultIf(valueType(start) !== "number", "NotNumber", null, start);
        faultIf(valueType(limit) !== "number", "NotNumber", null, limit);
        faultIf(start < 0 || start >= self.length, "Bounds", null, start);
        faultIf(limit < start || limit >= self.length, "Bounds", null, start);
        return self.slice(start, limit);
    },

    "{}[]": (self, args) => {
        let [offset] = args;
        faultIf(valueType(offset) !== "number", "NotNumber", null, offset);
        faultIf(offset < 0 || offset >= self.length, "Bounds", null, offset);
        return self.charCodeAt(offset);
    },
};

behaviors.string = makeBehavior(strUnops, strBinops, strMethods, "string");

//==============================
// VNum (happens to be Lua number)
//==============================

let numUnops = {
    "-": (a) => -a,
};

let numBinops = {
    "{}^": (a, b) => a ^ b,
    "{}*": (a, b) => a * b,
    "{}/": (a, b) => a / b,
    "{}//": (a, b) => Math.floor(a / b),
    "{}%": (a, b) => a % b,
    "{}+": (a, b) => a + b,
    "{}-": (a, b) => a - b,
    "{}<": (a, b) => a < b,
    "{}==": (a, b) => a == b,
    "{}!=": (a, b) => a !== b,
    "{}<=": (a, b) => a <= b,
    "{}<": (a, b) => a < b,
    "{}>=": (a, b) => a >= b,
    "{}>": (a, b) => a > b,
};

behaviors.number = makeBehavior(numUnops, numBinops, {}, "number");

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
    "{}++": (a, b) => {
        let o = clone(a);
        return move(b, 1, b.length, o.length+1, o);
    },
};

let vecMethods = {
    slice: (self, args) => {
        let [start, limit] = args;
        faultIf(valueType(start) !== "number", "NotNumber", null, start);
        faultIf(valueType(limit) !== "number", "NotNumber", null, limit);
        faultIf(start < 0 || start >= self.length, "Bounds", null, start);
        faultIf(limit < start || limit >= self.length, "Bounds", null, start);
        return N("VVec", ...self.slice(start, limit));
    },

    set: (self, args) => {
        let [index, value] = args;
        faultIf(valueType(index) !== "number", "NotNumber", null, index);
        // enforce contiguity (growable, but one at a time)
        faultIf(index < 0 || index > self.length, "Bounds", null, index);
        return set(self, index, value);
    },

    "{}[]": (self, args) => {
        let [offset] = args;
        faultIf(valueType(offset) !== "number", "NotNumber", null, offset);
        faultIf(offset < 0 || offset >= self.length, "Bounds", null, offset);
        return self[offset];
    },
};

behaviors.VVec = makeBehavior(vecUnops, vecBinops, vecMethods, "VVec");

natives.vvecNew = (...args) => {
    return N("VVec", ...args);
};

// Note different calling convention than `{}[]`.
//
natives.vvecNth = (self, n) => {
    faultIf(valueType(self) !== "VVec", "NotVVec", null, self);
    faultIf(valueType(n) !== "number", "NotNumber", null, n);
    faultIf(n < 0 || n >= self.length, "Bounds", null, self);
    return self[n];
}

// tests
//
let tv1 = natives.vvecNew(newValue(9), newValue(8));
test.eq(tv1, N("VVec", 9, 8));
test.eq(natives.vvecNth(tv1, newValue(0)), newValue(9));

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
        faultIf(valueType(name) !== "string", "NotString", null, name);
        let ndx = recFindPair(self, name);
        ndx = (ndx == null ? self.length : ndx);
        return set(self, ndx, [name, value]);
    },
};

let recBase = makeBehavior({}, recBinops, recMethods, "VRec");

behaviors.VRec = function (value, name) {
    let ndx = recFindPair(value, name);
    return ndx == null
        ? recBase(value, name)
        : value[ndx][1];
};

natives.vrecNew = (names, values) => {
    let v = set([], "T", "VRec");
    for (let ii of names.keys()) {
        v[ii] = [names[ii], values[ii]];
    }
    return v;
};

// recDef: names -> values -> record
natives.recDef = (names) => {
    return N('VFun',
             emptyEnv,
             N("INat", natives.vrecNew, [N("IVal", names), N("IArg", 0)]));
};


//----------------
// tests
//----------------

let rval = natives.vrecNew( natives.vvecNew("a", "b"),
                            natives.vvecNew(1, 2) );
test.eq(0, recFindPair(rval, "a"))
test.eq(1, recFindPair(rval, "b"))
test.eq(undefined, recFindPair(rval, "x"))
test.eq(behaviors.VRec(rval, "b"), 2);
let rv2 = recMethods.setProp(rval, ["b", 7]);
test.eq(behaviors.VRec(rv2, "b"), 7);


//==============================
// Store names of native functions for debugging
//==============================

natives.stop = () => {
    faultIf(true, "Stop");
}

for (let [name, fn] of Object.entries(natives)) {
    nfnNames[fn] = name;
}

//==============================================================
// desugarM: Middle Language to Inner Language
//==============================================================
//
// Translation from ML to IL involves the following (among others):
//
//  * Named variable references are converted to de Bruijn indices. At this
//    stage, undefined variable references and shadowing violations are
//    detected.
//
//  * Multi-argument ML functions are described in terms of single-argument
//    IL functions that accept an argument bundle (currently just a vector).
//

//==============================
// Scope object
//==============================

let emptyScope = {
    depth: 0,
    macros: {},
};

function scopeExtend(scope, names) {
    let depth = scope.depth + 1;
    let s = clone(scope);
    s.depth = depth;
    for (let [ii, name] of names.entries()) {
        s[name] = {depth: depth, offset: ii};
    }
    return s;
}

function scopeFind(scope, name) {
    let defn = scope[name];
    if (defn) {
        return [scope.depth - defn.depth, defn.offset];
    }
}

//==============================
// DesugarM
//==============================

// assert(natives.recDef);
// assert(natives.stop);
let builtins = {
   // Just return the arg bundle (currently the same as a vector)
    ".vecNew": N("VFun", emptyEnv, N("IArg", 0)),
    ".recDef": N("VFun", emptyEnv, N("INat", natives.recDef, [N("IArg", 0)])),
    ".stop": N("VFun", emptyEnv, N("INat", natives.stop, [])),
}

function mnameToString(ast) {
    test.assert(ast.T == "MName(");
    return ast[0];
}

// Return array of variable names assigned within `node`
//
function findLets(node) {
    let typ = node.T;
    let vars = [];
    let subexprs = [];
    if (typ == "MFun") {
        let [params, body] = node;
        vars = params;
        subexprs = [body];
    } else if (typ == "MCall") {
        let [fn, args] = node;
        subexprs = append([fn], args);
    } else if (typ == "MProp") {
        let [value, name] = node;
        subexprs = [value];
    } else if (typ == "MLoop") {
        let [body, k] = node;
        subexprs = [body, k];
    }

    for (let e of subexprs) {
        vars = append(vars, findLets(e));
    }
    return vars;
}

function mbreak(loopVars) {
    return mcall(mname(".post"), loopVars.map(mname));
}

function mrepeat(loopVars) {
    return mcall(mname(".body"), append([".body"], loopVars).map(mname));
}

// Reduce an MLoop expression to other ML expressions
//
//  (Loop BODY K) =->
//     .post = (VARS) -> K
//     break ~~> .post(VARS)
//     repeat ~~> .body(body, VARS)
//     .body = (.body, VARS) -> BODY
//     repeat
//
function reduceMLoop(body, k, vars) {
    return mlet(".post", N("MFun", vars, k),
                mlet(".body", N("MFun", append([".body"], vars), body),
                     mrepeat(vars)));
}

function desugarM(node, scope) {
    let ds = (a) => desugarM(a, scope);
    let N = (typ, ...args) => Object.assign(args, {T: typ, ast: node});
    let isDefined = (name) => scopeFind(scope, name) != null;

    function nat(name, ...args) {
        test.assert(natives[name]);
        return N("INat", natives[name], args)
    }

    let typ = node.T;

    if (typ == "MName") {
        let [name] = node;
        if (builtins[name]) {
            return N("IVal", builtins[name]);
        }
        if (scope.macros[name]) {
            return ds(scope.macros[name]);
        }
        let r = scopeFind(scope, name);
        faultIf(r == null, "Undefined", node.ast, name);
        let [index, offset] = r;
        return nat("vvecNth", N("IArg", index), N("IVal", newValue(offset)));
    } else if (typ == "MVal") {
        let [value] = node;
        return N("IVal", newValue(value));
    } else if (typ == "MFun") {
        let [params, body, shadowMode] = node;
        // check for un-sanctioned shadowing
        for (let name of params) {
            if (shadowMode == "=") {
                faultIf(isDefined(name), "Shadow", node.ast, name);
            } else if (shadowMode == ":=") {
                faultIf(!isDefined(name), "Undefined", node.ast, name);
            }
        }
        return N("IFun", desugarM(body, scopeExtend(scope, params)));
    } else if (typ == "MCall") {
        let [fn, args] = node;
        return N("IApp", ds(fn), nat("vvecNew", ...args.map(ds)));
    } else if (typ == "MProp") {
        let [value, name] = node;
        return nat("getProp", ds(value), N("IVal", name));
    } else if (typ == "MLoop") {
        let [body, k] = node;
        let vars = findLets(body).filter(isDefined);
        let macros = {
            "break": mbreak(vars),
            "repeat": mrepeat(vars),
        };
        return desugarM(reduceMLoop(body, k, vars), set(scope, "macros", macros));
    } else if (typ == "MError") {
        let [desc, ast] = node;
        faultIf(true, "Error: " + desc, ast, null);
    } else {
        test.fail("unknown M-record: %s", mlFmt(node));
    }
}

function desugar(ast, scope) {
    return desugarM(desugarExpr(ast), scope);
}

function makeManifest(vars) {
    let names = Object.keys(vars).sort();
    let values = names.map(k => vars[k]);
    let scope = scopeExtend(emptyScope, names);
    let env = envBind(emptyEnv, natives.vvecNew(...values));;
    return [scope, env];
}

let manifestVars = {
    "true": true,
    "false": false,
};

let [manifestScope, manifestEnv] = makeManifest(manifestVars);

function evalAST(ast) {
    // create `scope` and `env` for manifest
    return eval(desugar(ast, manifestScope), manifestEnv);
}

//==============================================================
// Tests
//==============================================================

// Scope structure

let testScope = scopeExtend(scopeExtend(emptyScope, ['a', 'b']), ['x', 'y']);
test.eq([1,0], scopeFind(testScope, 'a'));
test.eq([0,1], scopeFind(testScope, 'y'));

test.eq('1', ilFmt(desugar(N("Number", "1"))));
test.eq('$0[0]', ilFmt(desugar(N("Name", "a"), makeManifest({a: 1})[0])));


function trapEval(fn, ...args) {
    let value;
    try {
        value = fn(...args);
    } catch (err) {
        if (err.fault) {
            //test.printf("err:\n%s", err.stack);
            return err.fault;
        }
        throw err;
    };
    return value;
}

function et(source, evalue, eoob) {
    source = source.replace(/ \| /g, "\n");
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

et("x", '(VErr "Undefined" [] "x")');

// literals and constructors

et("1.23", "1.23");
et('"abc"', '"abc"');
et("[1,2,3]", "[1, 2, 3]");
et("{a: 1, b: 2}", "{a: 1, b: 2}");

// Fn

et("x -> x", "(...) -> $0[0]");

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
et("assert 2>3 | 1", '(VErr "Stop" [] undefined)');

// Let

et("x = 1 | x + 2", "3");
et("x = 1 | x := 2 | x + 2 | ", "4");
et("x = 1 | x += 2 | x + 2 | ", "5");
et("x = 1 | x = 2 | x | ", '(VErr "Shadow" [] "x")');
et("x := 1 | x | ", '(VErr "Undefined" [] "x")');

et("x = [1,2] | x[0] := 3 | x | ", "[3, 2]");
et("x = [1,2] | x[0] += 3 | x | ", "[4, 2]");
et("x = {a:[1]} | x.a[1] := 2 | x", "{a: [1, 2]}");

// Loop

test.eq(mlFmt(reduceMLoop(N("MName", "break"), N("MName", "x"), ["x"])),
        fmtLet(".post",
               '(MFun ["x"] x)',
               fmtLet(".body",
                      '(MFun [".body" "x"] break)',
                      '(MCall .body [.body x])')));

et(L([ 'x = 1',
       'loop while x < 10:',
       '  x *= 2',
       'x',
     ]),
   '16');

// Match

et(L([
    'match 1:',
    '   2 => 3',
    '   x => x',
]), '1');

et(L([
    'match 2:',
    '   2 => 3',
    '   x => x',
]), '3');

et(L([
    'match [1,2]:',
    '     [] => 0',
    '     [2, x] => 1',
    '     [1, x] => x',
    '     _ => 9',
]), '2');

// Examples

let fibr = L([
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
]);

et(fibr, "13")

let fibloop = L([
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
]);

et(fibloop, "13");
