// desugar: Convert AST to IL

import {assert, eq, eqAt, printf} from "./test.js";
import {L} from "./misc.js";
import {AST, astFmt, astFmtV} from "./ast.js";

//==============================================================
// Inner Language
//==============================================================

// An IL expression is an array of IL ops in RPN order.  Each op produces
// one value; `App` consumes one or more previously-produced values (the
// function + the arguments); `Tag` produces the value it consumes.
//
// Generally, a non-empty array of ops produces one or more values.  An
// expression is an arrays that produces one value.
//
// Tag.n is the number of preceding ops that are enclosed by the tag.
//
let Op = {
    Val: (type, arg) => ({T:"Val", type, arg}),
    Arg: (ups, pos)  => ({T:"Arg", ups, pos}),
    Fun: (body)      => ({T:"Fun", body}),
    App: (nargs)     => ({T:"App", nargs}),
    Err: (name)      => ({T:"Err", name}),
    Tag: (ast, n)    => ({T:"Tag", ast, n}),
};

// IL expression constructors
//
//   IL.Val(type, args)      // constant/literal/runtime value
//   IL.Arg(ups, pos)        // argument reference
//   IL.Fun(body)            // function construction (lambda)
//   IL.App(fn, args)        // function application
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
// A given AST node may expand to a tree of many IL nodes.  Tag nodes
// associate an AST node with the IL node that computes its value.

let IL = {
    Val: (type, arg) => [Op.Val(type, arg)],
    Arg: (ups, pos) => [Op.Arg(ups, pos)],
    Fun: (body) => [Op.Fun(body)],
    App: (fn, args) => [...fn, ...args.flat(), Op.App(args.length)],
    Err: (name) => [Op.Err(name)],
    Tag: (ast, il) => [...il, Op.Tag(ast, il.length)],
};

IL.fmtOp = op => op.T + " "
    + (op.T == "Val" ? op.type + "/" + op.arg :
       op.T == "Arg" ? op.ups + ":" + op.pos :
       op.T == "Fun" ? "[" + op.body.map(IL.fmtOp).join(", ") + "]" :
       op.T == "App" ? op.nargs :
       op.T == "Err" ? op.name :
       op.T == "Tag" ? op.n + " " +"@" + op.ast.pos :
       "?");

IL.fmt = il => il.map(IL.fmtOp).join("; ");

IL.detag = il =>
    il.map(op => (op.T == "Tag" ? [] :
                  op.T == "Fun" ? IL.Fun(IL.detag(op.body)) :
                  [op]))
    .flat();

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

// Construct a "fake" Block AST nodes with additional context, loopVars,
// which is produced and consumed only by this module.
//
let astBlock = (block, loopVars) => {
    let ast = AST.Block(block);
    ast.loopVars = loopVars;
    return ast;
};

let astLet = (target, value, body) =>
    AST.Call( AST.Fn([target], body), [value]);

let astSend = (expr, name, ...args) =>
    AST.Call( AST.Dot(expr, AST.Name(name)), args);

let stringFromName = (ast) => {
    assert(ast.T == "Name");
    return ast.str;
};

//==============================================================
// Desugar logic
//==============================================================

// Desugar a complex assignment target by transforming its value (AST -> AST)
//
//    x.a = y     -->  x = x.setProp("a", y)
//    x.a[1] = 2  -->  x = x.setProp("a", x.a.set(1, 2))
//
let unwrapTarget = (target, value) => {
    if (target.T == "Name") {
        return [target, value];
    } else if (target.T == "Index") {
        let {a, b} = target;
        return unwrapTarget(a, astSend(a, "set", b, value));
    } else if (target.T == "Dot") {
        let {a, name} = target;
        let str = AST.String(stringFromName(name));
        return unwrapTarget(a, astSend(a, "setProp", str, value));
    } else {
        fail("bad target");
    }
};

// Construct an IL "case" construct from AST parameters.
let xlatCase = (value, pattern, onMatch, onFail) => {
    if (pattern.T == "Name") {
        return astLet(pattern, value, onMatch);
    } else if (pattern.T == "Number" || pattern.T == "String") {
        let cond = AST.Binop("==", pattern, value);
        return AST.IIf(cond, onMatch, onFail);
    } else if (pattern.T == "VecPattern") {
        // Match(V, [P0,P1,...], M, F) -->
        //   Match(V[0], P0, Match(V[1], P1, ... M ... , F), F)
        let {elems} = pattern;
        let m = AST.Fn([], onMatch);
        let f = AST.Name(".fail");
        for (let [index, elem] of elems.entries()) {
            m = xlatCase(AST.Index(value, AST.Number(index)), elem, m, f);
        }
        return AST.Call(astLet(f, AST.Fn([], onFail), m), []);
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
            let {block} = ast;
            for (let s of block) {
                if (s.T == "S-Let") {
                    let {target} = s;
                    let nameStr = stringFromName(target);
                    if (!seen.has(nameStr)) {
                        seen.add(nameStr);
                        vars.push(target);
                    }
                } else if (s.T == "S-Loop") {
                    let {block} = s;
                    recur(AST.Block(block));
                } else if (s.T == "S-LoopWhile") {
                    let {block} = s;
                    recur(AST.Block(block));
                } else if (s.T == "S-If") {
                    let {then} = s;
                    assert(then.T == "Block");
                    recur(then);
                }
            }
        }
    };
    recur(ast);
    return vars;
};

let bodyName = AST.Name(".body");
let postName = AST.Name(".post");

// Convert a loop to more primitive AST records.
//
let xlatLoop = (body, k, loopVars) => {
    let bodyArgs = [bodyName, ...loopVars];
    return astLet(postName, AST.Fn(loopVars, k),
                  astLet(bodyName, AST.Fn(bodyArgs, body),
                         AST.Call(bodyName, bodyArgs)));
};

// Construct an IL function from AST body & params
let dsFun = (body, params, env) =>
    IL.Fun(env.extend(params.map(stringFromName)).desugar(body));

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
                    : AST.Error("nonExprAtEndOfBlock"));
    let node;

    if (T == "S-If") {
        let {cond, then} = ast;
        if (loopVars) {
            // allow `break` or `repeat` within a THEN clause
            if (then.T == "Block") {
                then = astBlock(then.block, loopVars);
            } else {
                then = astBlock([then], loopVars);
            }
        }
        node = dsIf(cond, then, kf(), env);
    } else if (T == "S-Let") {
        let {target, op, value} = ast;
        if (op != "=" && op != ":=") {
            // handle `+=`, `*=`, etc.
            let binop = op.match(/^[^=]+/);
            value = AST.Binop(binop, target, value);
        }
        [target, value] = unwrapTarget(target, value);
        let isBound = env.find(stringFromName(target));
        if (op == "=" && isBound) {
            return IL.Err("Shadow:" + stringFromName(target));
        } else if (op != "=" && !isBound) {
            return IL.Err("Undefined:" + stringFromName(target));
        }
        node = dsLet([target], value, kf(), env);
    } else if (T == "S-Loop") {
        let {block} = ast;
        let lastStmt = block[block.length - 1];
        if (!( lastStmt &&
               lastStmt.T == "Name" &&
               lastStmt.str == "break")) {
            block = [...block, AST.Name("repeat")];
        }
        let body = AST.Block(block);
        let vars = getLoopVars(body).filter(n => env.find(stringFromName(n)));
        let simple = xlatLoop(astBlock(block, vars), kf(), vars);
        node = env.desugar(simple);
    } else if (T == "S-While") {
        let {cond} = ast;
        node = dsIf(cond, kf(), astBlock([AST.Name("break")], loopVars), env);
    } else if (T == "S-LoopWhile") {
        let {cond, block} = ast;
        let loop = AST.SLoop([AST.SWhile(cond), ...block]);
        node = dsBlock([loop, ...rest], loopVars, env);
    } else if (T == "S-Assert") {
        let {cond} = ast;
        node = dsIf(cond, kf(), AST.Call(AST.Name(".stop"), []), env);
    } else {
        // Expression | break | repeat
        if (rest.length == 0) {
            // terminating expression/break/repeat
            if (loopVars && ast.T == "Name") {
                let {str} = ast;
                if (str == "repeat") {
                    ast = AST.Call(bodyName, [bodyName, ...loopVars]);
                } else if (str == "break") {
                    ast = AST.Call(postName, loopVars);
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
    let recur = expr => desugar(expr, env);
    let T = ast.T;
    let node;
    //test.printf("AST: %s\n", astFmt(ast));

    if (T == "Block") {
        // loopVars is present only when Block is constructed by desugaring
        let {block} = ast;
        let loopVars = ast.loopVars;
        node = dsBlock(block, loopVars, env);
    } else if (T == "Number") {
        node = IL.num(ast.str);
    } else if (T == "String") {
        node = IL.str(ast.str);
    } else if (T == "Name") {
        let {str} = ast;
        if (str == "repeat" || str == "break") {
            node = IL.Err("bad " + str);
        } else if (str == ".stop") {
            node = IL.lib("stop");
        } else {
            let rec = env.find(str);
            if (!rec) {
                node = IL.Err("Undefined:" + str);
            } else {
                let [ups, pos] = rec;
                node = IL.Arg(ups, pos);
            }
        }
    } else if (T == "Fn") {
        let {params, body} = ast;
        node = dsFun(body, params, env);
    } else if (T == "Call") {
        let {fn, args} = ast;
        node = IL.App(recur(fn), args.map(recur));
    } else if (T == "Dot") {
        let {a, name} = ast;
        node = IL.prop(recur(a), stringFromName(name));
    } else if (T == "Index") {
        let {a, b} = ast;
        node = IL.send(recur(a), "@[]", recur(b));
    } else if (T == "Binop") {
        let {op, a, b} = ast;
        node = op == "$"
            ? IL.App(recur(a), [recur(b)])
            : IL.send(recur(a), "@" + op, recur(b));
    } else if (T == "Unop") {
        let {op, a} = ast;
        node = IL.prop(recur(a), op);
    } else if (T == "IIf") {
        let {cond, a, b} = ast;
        node = dsIf(cond, a, b, env);
    } else if (T == "Vector") {
        let {elems} = ast;
        node = IL.App(IL.lib("vecNew"), elems.map(recur));
    } else if (T == "Map") {
        let {kvs} = ast;
        let keys = [];
        let values = [];
        for (let ii = 0; ii < kvs.length; ii += 2) {
            keys.push( IL.str(stringFromName(kvs[ii])) );
            values.push( kvs[ii+1] );
        }
        let mapCons = IL.App(IL.lib("mapDef"), keys);
        node = IL.App(mapCons, values.map(recur));
    } else if (T == "Match") {
        let {value, cases} = ast;
        let v = AST.Name(".value");
        let m = AST.Name(".stop");
        for (let c of cases.slice().reverse()) {
            assert(c.T == "S-Case");
            let {pattern, body} = c;
            m = xlatCase(v, pattern, body, m);
        }
        node = recur(astLet(v, value, m));
    } else if (T == "Missing") {
        node = IL.Err("missing");
    } else if (T == "Error") {
        // constructed only by desugaring
        let {str} = ast;
        node = IL.Err(str);
    } else {
        node = IL.Err("unknownExpr:" + T);
    }

    // AST nodes without pos are "synthetic" products of desugaring
    return ast.pos != null ? IL.Tag(ast, node) : node;
};

export {Env, IL, Op};

//==============================================================
// Tests
//==============================================================

import {parseModule} from "./parse.js";

let testEnv = new Env(['a', 'b']).extend(['x', 'y']);
eq([1,0], testEnv.find('a'));
eq([0,1], testEnv.find('y'));

let parseToAST = (src) => parseModule(src)[0];
let parseExpr = (src) => parseToAST(src).block[0];

let anum = (num) => AST.Number(String(num));
let avar = (str) => AST.Name(str);

let astEQ = (a, b) => eqAt(2, astFmt(a), astFmt(b));

let $x = IL.Arg(0, 0);  // 'x' in testEnv
let $a = IL.Arg(1, 0);  // 'a' in testEnv
let $b = IL.Arg(1, 1);  // 'b' in testEnv
let $1 = IL.num(1);
let $2 = IL.num(2);

let serializeIL = input =>
    IL.fmt(IL.detag(input instanceof Array && input[0].T
                    ? input // IL
                    : desugar(parseToAST(L(input)), testEnv)));  // source

let ilEQ = (a, b) => eqAt(2, serializeIL(a), serializeIL(b));

// test IL.prop
eq(IL.prop($a, "p"), IL.App(IL.getProp, [$a, IL.str("p")]));

// test IL.send
eq(IL.send($a, "p", $1), IL.App( IL.prop($a, "p"), [$1]));

// test unwrapTarget

let test_unwrapTarget = (srcA, srcB) => {
    let a = parseExpr(srcA);
    let [target, value] = unwrapTarget(a.target, a.value);
    astEQ(AST.SLet(target, a.op, value), parseExpr(srcB));
};

test_unwrapTarget('x = 1', 'x = 1');
test_unwrapTarget('a.x = 1', 'a = a.setProp("x", 1)');
test_unwrapTarget('a[1] = 2', 'a = a.set(1, 2)');
test_unwrapTarget('a[1].x = 2', 'a = a.set(1, a[1].setProp("x", 2))');

// xlatCase

//  p => 1
astEQ(xlatCase(avar("v"), avar("p"), anum(1), anum(2)),
      astLet(avar("p"), avar("v"), anum(1)));

//  0 => 1
astEQ(xlatCase(avar("v"), anum(0), anum(1), anum(2)),
      AST.IIf(AST.Binop("==", anum(0), avar("v")),
              anum(1),
              anum(2)));

//  [3,p] => 1
astEQ(xlatCase(avar("v"), AST.VecPattern([anum(3), avar("p")]),
               anum(1), anum(2)),
      AST.Call(astLet(avar(".fail"), AST.Fn([], anum(2)),
                      astLet(avar("p"), AST.Index(avar("v"), anum(1)),
                             AST.IIf(AST.Binop("==", anum(3),
                                               AST.Index(avar("v"), anum(0))),
                                     AST.Fn([], anum(1)),
                                     avar(".fail")))),
               []));

// test getLoopVars

astEQ([avar("foo"), avar("bar"), avar("baz"), avar("qux")],
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
    xlatLoop(avar("x"), avar("y"), [ avar("x") ]),

    astLet( avar(".post"), AST.Fn([avar("x")], avar("y")),
            astLet( avar(".body"), AST.Fn([avar(".body"), avar("x")],
                                          avar("x")),
                    AST.Call( avar(".body"), [avar(".body"), avar("x")]))));

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
