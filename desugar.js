// desugar: Convert AST to IL

import {assert, eq, eqAt} from "./test.js";
import {L, N, sexprFormatter} from "./misc.js";
import {astFmt, parseModule} from "./syntax.js";

//==============================================================
// Inner Language
//==============================================================

// Inner Language nodes (IExpr's)
//   IL.Val(type, args)      // constant/literal/runtime value
//   IL.Arg(index)           // argument reference
//   IL.Fun(body)            // function construction (lambda)
//   IL.App(fn, arg)         // function application
//   IL.Err(desc)            // syntax/compilation error
//   IL.Tag(ast, il)         // identify source code expression
//
// value : VNode
// index : (native) number
// nfn : (native) function
// desc : string
// ast : AST node
// il : IL node
// all others : IExpr || [IExpr]
//
// A given AST node may expand to a tree of many IL nodes.  Instead of
// annotating every IL node with its originiating AST node, we use IL Tag
// nodes to associate an AST node with the IL node that computes its value.
// Tag nodes do not affect the value computed by the IL tree.

let IL = {
    Val: (type, arg) => N("IVal", type, arg),
    Arg: (ups, pos) => N("IArg", ups, pos),
    Fun: (body) => N("IFun", body),
    App: (fn, args) => N("IApp", fn, args),
    Err: (desc) => N("IErr", desc),
    Tag: (ast, il) => N("ITag", ast, il),
};

IL.fmt = sexprFormatter({
    // $0 = argument to this function; $1 = argument to parent, ...
    IArg: (e) => "$" + e[0] + ":" + e[1],
    // number, string
    IVal: (e) => (e[0] == "Number" ? String(e[1]) :
                  e[0] == "String" ? '"' + e[1] + '"' :
                  e[1]),
    ITag: (e, f) => f(e[1]),
});

IL.str = str  => IL.Val("String", str);
IL.num = num  => IL.Val("Number", String(num));
IL.lib = name => IL.Val("Lib", name);
IL.getProp = IL.lib("getProp");
IL.prop = (target, name) => IL.App(IL.getProp, [target, IL.str(name)]);
IL.send = (target, name, ...args) => IL.App( IL.prop(target, name), args);
// Note: a & b will be wrapped in IL.Fun without adjusting their 'ups'
IL.iif = (cond, a, b) => IL.App(IL.send(cond, "switch", IL.Fun(a), IL.Fun(b)), []);

//==============================
// Env object
//==============================

class Env {
    constructor(names, parent) {
        this.depth = parent ? parent.depth + 1 : 0;
        this.entries = new Map(parent ? parent.entries : null);
        for (let [ii, name] of (names ?? []).entries()) {
            this.entries.set(name, {depth: this.depth, offset: ii});
        }
    }

    extend(names) {
        return new Env(names, this);
    }

    find(name) {
        let defn = this.entries.get(name);
        if (defn) {
            return [this.depth - defn.depth, defn.offset];
        }
    }

    desugar(ast) {
        return desugar(ast, this);
    }
}

//==============================================================
// AST constructors
//==============================================================

let astName  = (str)          => N("Name", str);
let astCall  = (fn, args)     => N("Call", fn, args);
let astFn    = (params, body) => N("Fn", params, body);
let astBlock = (lines, vars)  => N("Block", lines, vars);
let astBinop = (op, a, b)     => N("Binop", op, a, b);
let astIIf   = (cond, a, b)   => N("IIf", cond, a, b);
let astAssert = (cond)        => N("S-Assert", cond);
let astError = (desc)         => N("Error", desc);

let astLet = (target, value, body) =>
    astCall( astFn([target], body), [value]);

let astSend = (expr, name, ...args) =>
    astCall( N("Dot", expr, astName(name)), args);

let astIndex = (vec, index) => N("Index", vec, index);

let astNum = (num) => N("Number", String(num));

let astName_string = (ast) => {
    assert(ast.T == "Name");
    return ast[0];
};

//==============================================================
// Desugar logic
//==============================================================

// Construct an IL "case" construct from AST parameters.
let xlatCase = (value, pattern, onMatch, onFail) => {
    let typ = pattern.T;
    if (typ == "Name") {
        let [name] = pattern;
        return astLet(pattern, value, onMatch);
    } else if (typ == "Number" || typ == "String") {
        let cond = astBinop("==", pattern, value);
        return astIIf(cond, onMatch, onFail);
    } else if (typ == "VecPattern") {
        // Match(V, [P0,P1,...], M, F) -->
        //   Match(V[0], P0, Match(V[1], P1, ... M ... , F), F)
        let [elems] = pattern;
        let m = astFn([], onMatch);
        let f = astName(".fail");
        for (let [index, elem] of elems.entries()) {
            m = xlatCase(astIndex(value, astNum(index)), elem, m, f);
        }
        return astCall(astLet(f, astFn([], onFail), m), []);
    } else {
        return IL.Err("bad case");
    }
};

// Return an array of variables that are re-bound by `Let` in one of the
// statements of the block, or in a sub-block contained in one of those
// statements, and so on.  Statements with sub-blocks are: If, For, Loop,
// LoopWhile.
//
let getLoopVars = (ast) => {
    let vars = [];
    let seen = new Set();

    let recur = (ast) => {
        if (ast.T == "Block") {
            let [stmts] = ast;
            for (let s of stmts) {
                if (s.T == "S-Let") {
                    let [target] = s;
                    if (!seen.has(target[0])) {
                        seen.add(target[0]);
                        vars.push(target);
                    }
                } else if (s.T == "S-Loop") {
                    let [lines] = s;
                    recur(astBlock(lines));
                } else if (s.T == "S-LoopWhile") {
                    let [_, lines] = s;
                    recur(astBlock(lines));
                } else if (s.T == "S-If") {
                    let [_, then] = s;
                    assert(then.T == "Block");
                    recur(then);
                }
            }
        }
    };
    recur(ast);
    return vars;
};

let bodyName = astName(".body");
let postName = astName(".post");

// Convert a loop to more primitive AST records.
//
let xlatLoop = (body, k, loopVars) => {
    let bodyArgs = [bodyName, ...loopVars];
    return astLet(postName, astFn(loopVars, k),
                  astLet(bodyName, astFn(bodyArgs, body),
                         astCall(bodyName, bodyArgs)));
};

// Desugar a complex assignment target by transforming its value (AST -> AST)
//
//    x.a = y     -->  x = x.setProp("a", y)
//    x.a[1] = 2  -->  x = x.setProp("a", x.a.set(1, 2))
//
let unwrapTarget = (target, value) => {
    let ast = target;
    if (target.T == "Name") {
        return [target, value];
    } else if (target.T == "Index") {
        let [array, idx] = target;
        return unwrapTarget(array, astSend(array, "set", idx, value));
    } else if (target.T == "Dot") {
        let [rec, name] = target;
        let str = N("String", astName_string(name));
        return unwrapTarget(rec, astSend(rec, "setProp", str, value));
    } else {
        return N("Error", "bad target");
    }
};

// Construct an IL function from AST body & params
let dsFun = (body, params, env) =>
    IL.Fun(env.extend(params.map(astName_string)).desugar(body));

// Construct an IL "if" construct from AST condition, then, & else
let dsIf = (c, a, b, env) =>
    IL.App(IL.send(env.desugar(c),
                   "switch",
                   dsFun(a, [], env),
                   dsFun(b, [], env)), []);

// Construct an IL "let" construct from AST variable name, value, and body.
let dsLet = (targets, value, body, env) =>
    IL.App( dsFun(body, targets, env), [env.desugar(value)]);

// Construct an IL expression for a block, given a sequence of AST block lines.
//
let dsBlock = (lines, loopVars, env) => {
    let [ast, ...rest] = lines;
    let T = ast.T;
    let kf = () => (rest.length > 0
                    ? astBlock(rest, loopVars)
                    : astError("nonExprAtEndOfBlock"));
    let node;

    if (T == "S-If") {
        let [cond, then] = ast;
        if (loopVars) {
            // allow `break` or `repeat` within a THEN clause
            if (then.T == "Block") {
                then = astBlock(then[0], loopVars);
            } else {
                then = astBlock([then], loopVars);
            }
        }
        node = dsIf(cond, then, kf(), env);
    } else if (T == "S-Let") {
        let [target, aop, value] = ast;
        if (aop != "=" && aop != ":=") {
            // handle `+=`, `*=`, etc.
            let op = aop.match(/^[^=]+/);
            value = astBinop(op, target, value);
        }
        [target, value] = unwrapTarget(target, value);
        let isBound = env.find(astName_string(target));
        if (aop == "=" && isBound) {
            return IL.Err("Shadow:" + astName_string(target));
        } else if (aop != "=" && !isBound) {
            return IL.Err("Undefined:" + astName_string(target));
        }
        node = dsLet([target], value, kf(), env);
    } else if (T == "S-Loop") {
        let [lines] = ast;
        let lastStmt = lines[lines.length - 1];
        if (!( lastStmt &&
               lastStmt.T == "Name" &&
               lastStmt[0] == "break")) {
            lines.push(astName("repeat"));
        }
        let body = astBlock(lines);
        let vars = getLoopVars(body).filter(n => env.find(astName_string(n)));
        let simple = xlatLoop(astBlock(lines, vars), kf(), vars);
        node = env.desugar(simple);
    } else if (T == "S-While") {
        let [cond] = ast;
        node = dsIf(cond, kf(), astBlock([astName("break")], loopVars), env);
    } else if (T == "S-LoopWhile") {
        let [cond, block] = ast;
        let loop = N("S-Loop", [N("S-While", cond), ...block])
        node = dsBlock([loop, ...rest], loopVars, env);
    } else if (T == "S-Assert") {
        let [cond] = ast;
        node = dsIf(cond, kf(), astCall(astName(".stop"), []), env);
    } else {
        // Expression | break | repeat
        if (rest.length == 0) {
            // terminating expression/break/repeat
            if (loopVars && ast.T == "Name") {
                let [name] = ast;
                if (name == "repeat") {
                    ast = astCall(bodyName, [bodyName, ...loopVars]);
                } else if (name == "break") {
                    ast = astCall(postName, loopVars);
                }
            }
            return env.desugar(ast);
        } else {
            // mid-block expression
            node = dsLet([], ast, kf(), env);
        }
    }

    return IL.Tag(ast, node);
};

// Desugar an AST expression
let desugar = (ast, env) => {
    if (!env) todo();
    let recur = expr => desugar(expr, env);
    let T = ast.T;
    let node;
    //test.printf("AST: %s\n", astFmt(ast));

    if (T == "Block") {
        // loopVars is present only when Block is constructed by desugaring
        let [lines, loopVars] = ast;
        node = dsBlock(lines, loopVars, env);
    } else if (T == "Number") {
        node = IL.num(ast[0]);
    } else if (T == "String") {
        node = IL.str(ast[0]);
    } else if (T == "Name") {
        let [name] = ast;
        if (name == "repeat" || name == "break") {
            node = IL.Err("bad " + name);
        } else if (name == ".stop") {
            node = IL.lib("stop");
        } else {
            let rec = env.find(name);
            if (!rec) {
                node = IL.Err("Undefined:" + name);
            } else {
                let [ups, pos] = rec;
                node = IL.Arg(ups, pos);
            }
        }
    } else if (T == "Fn") {
        let [params, body] = ast;
        node = dsFun(body, params, env);
    } else if (T == "Call") {
        let [fn, args] = ast;
        node = IL.App(recur(fn), args.map(recur));
    } else if (T == "Dot") {
        let [a, name] = ast;
        node = IL.prop(recur(a), astName_string(name));
    } else if (T == "Index") {
        let [a, b] = ast;
        node = IL.send(recur(a), "@[]", recur(b));
    } else if (T == "Binop") {
        let [op, a, b] = ast;
        node = op == "$"
            ? IL.App(recur(a), [recur(b)])
            : IL.send(recur(a), "@" + op, recur(b));
    } else if (T == "Unop") {
        let [op, svalue] = ast;
        node = IL.prop(recur(svalue), op);
    } else if (T == "IIf") {
        let [c, a, b] = ast;
        node = dsIf(c, a, b, env);
    } else if (T == "Vector") {
        let [elems] = ast;
        node = IL.App(IL.lib("vecNew"), elems.map(recur));
    } else if (T == "Map") {
        let [rpairs] = ast;
        let keys = [];
        let values = [];
        for (let ii = 0; ii < rpairs.length; ii += 2) {
            keys.push( IL.str(astName_string(rpairs[ii])) );
            values.push( rpairs[ii+1] );
        }
        let mapCons = IL.App(IL.lib("mapDef"), keys);
        node = IL.App(mapCons, values.map(recur));
    } else if (T == "Match") {
        let [value, cases] = ast;
        let v = astName(".value");
        let m = astName(".stop");
        for (let c of cases.slice().reverse()) {
            assert(c.T == "S-Case");
            let [pattern, body] = c;
            m = xlatCase(v, pattern, body, m);
        }
        node = recur(astLet(v, value, m));
    } else if (T == "Missing") {
        node = IL.Err("missing");
    } else if (T == "Error") {
        // constructed only by desugaring
        let [desc] = ast;
        node = IL.Err(desc);
    } else {
        node = IL.Err("unknownExpr:" + T);
    }

    // AST nodes without pos are "synthetic" products of desugaring
    return ast.pos != null ? IL.Tag(ast, node) : node;
};

//==============================================================
// desugar Tests
//==============================================================

let parseToAST = (src) => parseModule(src)[0];

let astEQ = (a, b) => eqAt(2, astFmt(a), astFmt(b));

let testEnv = new Env(['a', 'b']).extend(['x', 'y']);
eq([1,0], testEnv.find('a'));
eq([0,1], testEnv.find('y'));

let $x = IL.Arg(0, 0);  // 'x' in testEnv
let $a = IL.Arg(1, 0);  // 'a' in testEnv
let $b = IL.Arg(1, 1);  // 'b' in testEnv

let serializeIL = input =>
        IL.fmt(input.T ? input :                         // IL
               desugar(parseToAST(L(input)), testEnv));  // source

let ilEQ = (a, b) => eqAt(2, serializeIL(a), serializeIL(b));

let $1 = IL.num(1);
let $2 = IL.num(2);

// test IL.prop
eq(IL.prop($a, "p"), IL.App(IL.getProp, [$a, IL.str("p")]));

// test IL.send
eq(IL.send($a, "p", $1), IL.App( IL.prop($a, "p"), [$1]));

// test unwrapTarget

let test_unwrapTarget = (srcA, srcB) => {
    let parseLet = (src) => {
        let block = parseToAST(src);
        assert(block.T == "Block" && block[0][0].T == "S-Let");
        return block[0][0];
    }
    let [tA, _A, vA] = parseLet(srcA);
    let [tOut, vOut] = unwrapTarget(tA, vA);
    astEQ(N("S-Let", tOut, _A, vOut), parseLet(srcB));
};

test_unwrapTarget('x = 1', 'x = 1');
test_unwrapTarget('a.x = 1', 'a = a.setProp("x", 1)');
test_unwrapTarget('a[1] = 2', 'a = a.set(1, 2)');
test_unwrapTarget('a[1].x = 2', 'a = a.set(1, a[1].setProp("x", 2))');

// test getLoopVars

astEQ([astName("foo"), astName("bar"), astName("baz"), astName("qux")],
      getLoopVars(parseToAST(L([
          "foo := a",
          "loop:",
          "  foo := b",
          "  bar := c",
          "  if cond:",
          "    foo := d",
          "    baz := e",
          "    break",
          "  loop while 1:",
          "    qux := 1",
          "  break"
      ]))));

// test xlatLoop

astEQ(
    xlatLoop(astName("x"), astName("y"), [ astName("x") ]),

    astLet( astName(".post"), astFn([astName("x")], astName("y")),
            astLet( astName(".body"), astFn([astName(".body"), astName("x")],
                                            astName("x")),
                    astCall( astName(".body"), [astName(".body"), astName("x")]))));

// xlatCase

//  p => 1
astEQ(xlatCase(astName("v"), astName("p"), astNum(1), astNum(2)),
      astLet(astName("p"), astName("v"), astNum(1)));

//  0 => 1
astEQ(xlatCase(astName("v"), astNum(0), astNum(1), astNum(2)),
      astIIf(astBinop("==", astNum(0), astName("v")),
             astNum(1),
             astNum(2)));

//  [3,p] => 1
astEQ(xlatCase(astName("v"), N("VecPattern", [astNum(3), astName("p")]),
             astNum(1), astNum(2)),
      astCall(astLet(astName(".fail"), astFn([], astNum(2)),
                     astLet(astName("p"), astIndex(astName("v"), astNum(1)),
                            astIIf(astBinop("==", astNum(3),
                                            astIndex(astName("v"), astNum(0))),
                                    astFn([], astNum(1)),
                                    astName(".fail")))),
              []));

// Number
ilEQ("1", $1);

// String
ilEQ('"ABC"', IL.str("ABC"));

// Name
ilEQ("x", $x);
ilEQ("a", $a);
ilEQ("b", $b);

// Fn
ilEQ("x -> 1", IL.Fun($1));
ilEQ("x -> a", IL.Fun(IL.Arg(2, 0)));

// Call
ilEQ("x(1)", IL.App($x, [$1]));

// Dot
ilEQ("a.P", IL.prop($a, "P"));

// Index
ilEQ("a[1]", IL.send($a, "@[]", $1));

// Binop
ilEQ("x + 1", IL.send($x, "@+", $1));

// Binop `$`
ilEQ("a $ 1", IL.App($a, [$1]));

// Unop
ilEQ("-a", IL.prop($a, "-"));

// IIf ("inline" if)
ilEQ("x ? 1 : 2", IL.iif($x, $1, $2));

// Vector
ilEQ("[1, 2]", IL.App(IL.lib("vecNew"), [$1, $2]));

// Map
ilEQ("{A:1, B:2}", IL.App(IL.App(IL.lib("mapDef"), [IL.str("A"), IL.str("B")]), [$1, $2]));

// Match
ilEQ([
    'match 1:',
    '   2 => 3',
    '   z => z'
], [
    'v = 1',
    'if 2 == v:',
    '  3',
    'z = v',
    'z'
]);

// Block: S-If
ilEQ([
    "if a:",
    "  1",
    "2"
], [
    "a ? 1 : 2"
]);

// Block: S-Let
ilEQ(["z = 1", "z"],
     "((z) -> z)(1)");

// Block: S-Loop
ilEQ([ 'loop:',
       '  x := 1',
       '1'],
     [ 'post = (x) -> 1',
       'body = (body, x) ->',
       '   x := 1',
       '   body(body, x)',
       'body(body, x)']);

ilEQ([ 'loop:',
       '  x := 1',
       '  break',      // explicit `break` at end of loop
       '1'],
     [ 'post = (x) -> 1',
       'body = (body, x) ->',
       '   x := 1',
       '   post(x)',
       'body(body, x)']);

// Block: S-While
ilEQ([
    'loop:',
    '  while x',
    '  x := 1',
    '2'
], [
    'post = (x) -> 2',
    'body = (body, x) ->',
    '  if x:',
    '    x := 1',
    '    body(body, x)',
    '  post(x)',
    'body(body, x)',
]);

// Block: S-LoopWhile
ilEQ([
    'loop while x:',
    '  x := 1',
    '2'
], [
    'loop:',
    '  while x',
    '  x := 1',
    '2'
]);

// Block: S-Assert
ilEQ([ 'assert x', '1' ],
     IL.iif($x, $1, IL.App( IL.lib("stop"), [])));


//==============================================================
// exports
//==============================================================

export {Env, IL};
