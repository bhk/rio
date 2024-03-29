// parse: parse Rio source code

import {append, set} from "./misc.js";
import {P, S, NS, R, V, and, or, CC, cpos, fail, NoCaptures} from "./peg.js";
import {AST, astFmt, astFmtV} from "./ast.js";

// returns: match 0 or 1 occurrence of `p`
function opt(p) {
    return or(p, 0);
}

//==============================================================
// 2D Syntax
//==============================================================
//
// The 2D grammar has dependencies on "inline" syntax patterns:
//
//    AtBlock: Succeeds when at a line (post-indent) that should be treated
//       as the beginning of a block.
//
//    Comment: Matches a comment, consuming characters to the terminating NL.
//
//    LogLine: Consumes a logical line, beginning at its first non-SPACE
//       character. LogLine must not read beyond LF characters except via
//       the 2D `nlBlock` and `nlWhite` patterns.  Also, it must consume all
//       everything up to `nlEOL`: every non-NL character, `nlWhite`, and
//       `nlBlock`.
//
// 2D patterns only recognize two ASCII characters: LF and SPACE.  All other
// characters are left to be handled by inline syntax patterns.
//
// Empty lines (entirely whitespace or comments) are consumed by `nlWhite`,
// so they are "seen" by LogLine as whitespace.
//

let NL = P("\n");
let SPACE = P(" ");
let EOF = P(1).not;

// Create a pattern that matches spaces *if* `cmp(indent, state.n)` is true.
//
function matchIndent(cmp) {
    return P((subj, pos, state, g) => {
        let indent = 0;
        while (subj[pos+indent] === ' ') {
            ++indent;
        }
        if (cmp(indent, state.blockIndent)) {
            state = set(state, "lineIndent", indent)
            return [pos + indent, state, NoCaptures];
        }
    });
}

let indentGT = matchIndent( (x, y) => x > y );
let indentEQ = matchIndent( (x, y) => x === y );

// Create a pattern that matches `pat` with `state.blockIndent` set to
// `state.lineIndent`.
//
function inBlock(pat) {
    return P((subj, pos, state, g) => {
        let prevN = state.blockIndent;
        state = set(state, "blockIndent", state.lineIndent);
        let result = pat.match(subj, pos, state, g);
        if (!result) {
            return false;
        }
        let [posOut, stateOut, caps] = result;
        return [posOut, set(stateOut, "blockIndent", prevN), caps];
    });
}

// Match from start of a LogLine to NL at end of last LogLine
let blockBody = and(V("LogLine"), and(NL, indentEQ, V("LogLine")).X0);
let nlBlank = and(NL, or(SPACE.X1, V("Comment")).X0, or(NL, EOF).at);

// Skip whitespace before content of first line
let p2dModule = and(or(SPACE.X1, NL, V("Comment")).X0, blockBody)

// These patterns are provided for use by `LogLine`:
//
//   nlEOL: detects end of current logical line (doesn't consume)
//   nlWhite: consumes blank and all-comment lines to closing NL,
//      or consumes NL and indent before a continuation line.
//   nlBlock: consumes NL and a subsequent nested block.

let nlWhite = or(nlBlank, and(NL, indentGT, inBlock(V("AtBlock").not))).X1
let nlBlock = and(NL, indentGT, inBlock(and(V("AtBlock").at, blockBody)))
let nlEOL = or(and(NL, indentGT.not), EOF).at

// Initial parser state assumed by 2D parsing expressions
//
let p2dInitialState = {
    blockIndent: 0,
    oob: [],
}

//==============================
// Inline Syntax
//==============================

let NonNL = NS("\n");

function Node(typ, pos, end, ...args) {
    if (!AST[typ]) {
        fail("no AST[%q]!\n", typ);
    }
    let node = AST[typ](...args);
    node.pos = pos;
    node.end = end;
    return node;
}

// returns: match `patterns` and construct a Node from its captures
//
let M = (typ, ...patterns) =>
    and(cpos, and(...patterns).A, cpos).F(
        ([pos, a, end]) => [ Node(typ, pos, end, ...a) ]);

// returns: match pat and append its captures to state.oob
function Coob(pat) {
    return P( (subj, pos, state) => {
        let result = pat.match(subj, pos, state);
        if (!result) {
            return false;
        }
        let [posOut, stateOut, caps] = result;
        return [posOut,
                set(stateOut, "oob", append(stateOut.oob, caps)),
                NoCaptures];
    });
}

// returns: log an out-of-band error
function E(desc) {
    return Coob(M("Error", CC(desc)));
}

let nameInitial = R("az", "AZ", "__");
let nameChar = R("az", "AZ", "__", "09");
let opChar = S("!#$%&'*+-./<=>?\\^`|~");
// Remaining ASCII printables:  @{}():;,"

let comment = and(P("#").at, Coob(M("Comment", NonNL.X0.C)));

// skip whitespace
let controlChar = and(R("\x00\x09", "\x0b\x1f").at, E("BadChar"), 1);
let ss = or(S(" ").X1, nlWhite, comment, controlChar).X0;

let name = and(and(nameInitial, nameChar.X0).C, ss);

// returns: match and optionally capture any of a set of tokens
function matchTokens(tokens, isCapture) {
    let tokenPats = tokens.map( (str, index) => {
        // see what kind of token this is
        let after = (nameChar.match(str, 0) ? nameChar.not :
                     opChar.match(str, 0) ? opChar.not :
                     0); // P(0) always succeeds
        return and(str, after, (isCapture ? CC(str) : 0), ss);
    });
    return or(...tokenPats);
}

// returns: match a token
function T(...tokenStrings) {
    return matchTokens([...tokenStrings], false);
}

// returns: match and capture a token (used for Operators)
function O(...tokenStrings) {
    return matchTokens([...tokenStrings], true);
}

// Numeric literals

let digits = R("09").X1;
let numberExp = and(S("eE"), opt(S("+-")), or(digits, E("NumDigitExp")));
// digits [`.` digits]
let numberA = and(digits, opt(and(".", or(digits, E("NumDigitAfter")))));
// `.` digits    (accept, but flag as error)
let numberB = and(P(".").at, E("NumDigitBefore"), ".", digits);

let number = and(
    and(or(numberA, numberB), opt(numberExp)).C,
    or(or(nameChar, ".").not, E("NumEnd")),
    ss);

// String literals

let qchar = or(
    NS("\"\\\n").X1.C,
    and("\\\\", CC("\\")),
    and("\\\\", CC("\\")),
    and("\\\"", CC("\"")),
    and("\\r", CC("\r")),
    and("\\n", CC("\n")),
    and("\\t", CC("\t")),
    and("\\", E("StringBS"), CC("\\")));

function concat(captures) {
    return [captures.join('')];
}

let qstring = and('"', qchar.X0.F(concat), or('"', E("StringEnd")), ss);

// match words not to be confused with variable names
let stmtKeywords = T("if", "loop", "while", "for", "assert");
let keywords = or(T("and", "or", "not", "match"), stmtKeywords);

// returns: match comma-delimited sequence of zero-or-more `p`
function cseq(p) {
    return or(and(p, and(T(","), p).X0, opt(T(","))), 0).A;
}

let nameNode = M("Name", name);

let variable = and(keywords.not, nameNode);

let expr = V("Expr");
let needExpr = or(expr, M("Missing"));

let vector = and(T("["), cseq(expr), or(T("]"), E("CloseSquare")));

let mapNV = and(nameNode, T(":"), needExpr);
let map = and(T("{"), cseq(mapNV), or(T("}"), E("CloseCurly")));

let grouping = and(T("("), needExpr, or(T(")"), E("CloseParen")));

let needBlock = or( and(nlBlock.A, ss), M("MissingBlock"));

let atom = or(
    M("Number", number),
    M("String", qstring),
    variable,
    M("Vector", vector),
    M("Map", map),
    grouping,
    M("Block", nlBlock.A, ss),
    M("Match", T("match"), needExpr, T(":"), needBlock));

let binop = (op, a, b) => Node("Binop", a.pos, b.end, op, a, b);

let binopMerge = (a, op, b) => binop(op, a, b);

let sufMerge = (a, typ, b, end) => Node(typ, a.pos, end, a, b);

// left-associative operators
let joinLTR = mergeOp => captures => {
    let [e, ...others] = captures;
    for (let other of others) {
        e = mergeOp(e, ...other);
    }
    return [e];
}

let matchLTR = (e, pat) => and(e, and(pat, e).A.X0).F(joinLTR(binopMerge));

let matchSuf = (e, pat) => and(e, and(pat, cpos).A.X0).F(joinLTR(sufMerge));

// right-associative binary operators
function joinRTL(captures) {
    let [a, pos, op, ...others] = captures;
    if (op) {
        return [binop(op, a, ...joinRTL(others))];
    }
    return [a];
}

function matchRTL(e, pat) {
    return and(e, and(cpos, pat, e).X0).F(joinRTL);
}

// unary prefix operators
function joinPre(captures) {
    let [pos, op, ...others] = captures;
    if (op) {
        let expr = joinPre(others);
        return Node("Unop", pos, expr.end, op, expr);
    }
    // final capture is the expression
    return pos;
}

function matchPre(e, pat) {
    return and(and(cpos, pat).X0, e).F(caps => [joinPre(caps)]);
}

function joinRel(captures) {
    let [e1, pos, op, e2, pos2, ...others] = captures;
    if (pos == undefined) {
        return [e1];
    }
    let rel = binop(op, e1, e2);
    if (pos2 == undefined) {
        return [rel];
    }
    return [binop("and", rel, ...joinRel([e2, pos2, ...others]))];
}

function matchRel(e, pat) {
    return and(e, and(cpos, pat, e).X0).F(joinRel);
}

function joinIIf(captures) {
    let [e1, pos, e2, e3, ...others] = captures;
    if (pos == undefined) {
        return e1;
    }
    let k = joinIIf([e3, ...others]);
    return Node("IIf", pos, k.end, e1, e2, k);
}

function joinFn(captures) {
    let [pos, params, ...others] = captures;
    if (params == undefined) {
        return pos;
    }
    let body = joinFn(others);
    return Node("Fn", pos, body.end, params, body);
}

// Each suffix captures two values: nodeType & expr/arglist
let callSuffix =
    and(T("("), CC("Call"), cseq(expr), or(T(")"), E("CloseParen")));
let memberSuffix =
    and(T("["), CC("Index"), needExpr, or(T("]"), E("CloseSquare")));
let dotSuffix =
    and(T("."), CC("Dot"), or(nameNode, and(M("Missing"), E("DotName"))));

let params = or(and(T("("), cseq(variable), T(")")), variable.A);

function addOperations(e) {
    e = matchSuf(e, or(dotSuffix, callSuffix, memberSuffix));
    e = matchRTL(e, O("^"));
    e = matchPre(e, O("not", "-"));
    e = matchLTR(e, O("*", "/", "//", "%"));
    e = matchLTR(e, O("+", "-", "++"));
    e = matchRel(e, O("==", "!=", "<=", "<", ">=", ">"));
    e = matchLTR(e, O("and"));
    e = matchLTR(e, O("or"));
    e = and(e, and(cpos, T("?"), needExpr, or(T(":"), E("CloseIIf")), e).X0)
        .F(caps => [joinIIf(caps)]);
    e = matchRTL(e, O("$"));
    e = and(and(cpos, params, T("->")).X0, e).F(caps => [joinFn(caps)]);
    return e;
}

let ile = addOperations(atom);

//==============================
// Statements
//==============================

let letOp = O("=", ":=", "+=", "++=", "*=");

let letTarget = matchSuf(variable, or(dotSuffix, memberSuffix))

let pattern = or(
    variable,
    M("Number", number),
    M("String", qstring),
    M("VecPattern", T("["), cseq(V("Pattern")), T("]")));

let statement = or(
    M("SLet", letTarget, letOp, needExpr),
    M("SAct", params, T("<-"), needExpr),
    M("SCase", pattern, T("=>"), needExpr),
    M("SIf", T("if"), expr, T(":"), expr),
    M("SLoop", T("loop"), T(":"), needBlock),
    M("SLoopWhile", T("loop"), T("while"), expr, T(":"), needBlock),
    M("SWhile", T("while"), needExpr),
    M("SFor", T("for"), variable, T("in"), expr, T(":"), expr),
    M("SAssert", T("assert"), needExpr));

let atBlock = or(
    stmtKeywords,
    and(letTarget, letOp),
    and(params, T("<-")),
    and(pattern, T("=>")));

// consume everything to the end of the line
let discardEOL = and(E("Garbage"), or(NonNL.X1, nlWhite, nlBlock).X0)

let logLine = and(
    or( and(atBlock.at, or(statement, M("BadStmt"))),
        and(ss, ile),
        M("BadILE")),
    or(nlEOL.at, discardEOL));

let rioModule = M("Block", p2dModule.A);

let rioG = {
    Module: rioModule,
    Comment: comment,
    AtBlock: atBlock,
    LogLine: logLine,
    Expr: ile,
    Statement: statement,
    Pattern: pattern,
}

// Parse a module's source code (given in `subj`).  Returns [`node`, `oob`].
//   node = an AST node describing an expression
//   oob = an array of "out of band" captures (errors, comments)
//
// The result of parsing a module is a Block, which is an array of logical
// lines, each of which is an expression or a statement.
//
function parseModule(subj) {
    let [_, state, captures] = rioModule.match(subj, 0, p2dInitialState, rioG);
    return [captures[0], state.oob];
}

export {parseModule};

//==============================================================
// Tests
//==============================================================

import {eq, eqAt} from "./test.js";

//==============================
// 2D Parsing Tests
//==============================

let group = name => captures =>
    [ [name, ...captures] ];

let text = NonNL.X1.C;

// This minimal grammar for 2D parsing begins blocks only at "if ..." or
// "NAME = ...", and allows logical lines to contain any sequence of
// arbitrary text and/or nested blocks.   Blocks and lines are captured
// as ["B", ...] and ["L", ...].
//
let testGrammar = {
    AtBlock: or(T("if"), and(name, ss, T("="))),
    Comment: and("#", NonNL.X0),
    LogLine: and(text, or(nlWhite, text, nlBlock.F(group("B"))).X0)
        .F(group("L")),
};

// Match `subj` using `pattern` with a minimal grammar.
//
function testG(subj, pattern, ecaptures, eoob, epos) {
    let results = pattern.match(subj, 0, p2dInitialState, testGrammar);
    if (ecaptures == null) {
        eqAt(2, false, results);
        return;
    }
    let [pos, state, captures] = results;
    eqAt(2, ecaptures, captures);
    if (eoob != undefined) {
        eqAt(2, eoob, state ? astFmtV(state.oob) : "");
    }
    if (epos !== undefined) {
        eqAt(2, epos, pos);
    }
}

testG("if a", testGrammar.AtBlock, [], null, 3);
testG("\n  x = 1\n", nlWhite, null);
testG("\n  x = 1\n", nlBlock, [["L", "x = 1"]], null, 9);
testG("ile\n  x = 1\n", testGrammar.LogLine,
      [["L", "ile", ["B", ["L", "x = 1"]]]]);
testG("abc\n  def\n", testGrammar.LogLine,
      [["L", "abc", "def"]])

let txt =
    'if A:\n' +
    '    # c1\n' +
    '  # c2\n' +
    '# c3\n' +
    '  cont\n' +
    'if B:\n' +
    '\n' +
    '  x = 1\n' +
    '  x\n' +
    'ile\n';

testG(txt, blockBody,
      [ ["L", "if A:", "cont"],
        ["L", "if B:",
         ["B",
          ["L", "x = 1"],
          ["L", "x"]]],
        ["L", "ile"]]);

//==============================
// Inline Parsing Tests
//==============================

eq(astFmt(Node("Name", 5, 6, "x")), 'x');
eq(astFmt(Node("Number", 5, 6, "9")), '9');

{
    eq(M("Name", P("b").C).match("abc", 1, {}, {}),
       [2, {}, [Node("Name", 1, 2, "b")]]);
}

eq([1, p2dInitialState, []],
   ss.match(" \nx", 0, p2dInitialState, {Comment: fail}));

testG(" \nNext", ss, [], null, 1);
testG(" # c\n  x\n", ss, [], '(Comment "# c")', 7);
testG("\t x", ss, [], '(Error "BadChar")', 2);

testG("abc  ", O("abc"), ["abc"], null, 5);
testG("abc+ ", O("abc"), ["abc"], null, 3);
testG("abcd ", O("abc"), null);

testG("+    ", O("+"), ["+"], null, 5);
testG("+a   ", O("+"), ["+"], null, 1);
testG("+()  ", O("+"), ["+"], null, 1);
testG("+=   ", O("+"), null);

testG("()", number, null);
testG(".", number, null);
testG("7 ", number, ["7"], null, 2);
testG("7.5 ", number, ["7.5"]);
testG("7.0e0 ", number, ["7.0e0"]);
testG("7e+0 ", number, ["7e+0"]);
testG("7.e+1 ", number, ["7.e+1"], '(Error "NumDigitAfter")');
testG("7a ", number, ["7"], '(Error "NumEnd")');
testG("1.23.", number, ["1.23"], '(Error "NumEnd")');
testG(".5", number, [".5"], '(Error "NumDigitBefore")');

testG('"a\\\\\\t\\nb"   ', qstring, ["a\\\t\nb"], null, 13);
testG('"\\a"', qstring, ["\\a"], '(Error "StringBS")');
testG('"abc', qstring, ["abc"], '(Error "StringEnd")');

// Test a pattern.  eser = expected serialization
//
function testPat(pattern, subj, eser, eoob, level) {
    level = (level || 1) + 1;
    let r = pattern.match(subj, 0, p2dInitialState, rioG);
    let [pos, state, captures] = r ?? [-1, {}, "--failed--"];
    eqAt(level, eser, astFmtV(captures));
    eqAt(level, eoob || '', astFmtV(state.oob));
}

// Match `subj` using `atom`; avoid dependencies on syntax defined after
// atom.
//
function testAtom(subj, eser, eoob) {
    let g = {
        Expr: atom,
        Comment: fail,
        AtBlock: fail,
    };
    testPat(atom.G(g), subj, eser, eoob, 2);
}

// Match `subj` using LogLine.
//
function testL(subj, eser, eoob) {
    testPat(logLine, subj, eser, eoob, 2);
}

// Match `subj` using Module.
//
function testM(subj, eser, eoob) {
    let [node, oob] = parseModule(subj);
    eqAt(2, eser, astFmt(node));
    if (eoob) {
        eqAt(2, eoob, astFmtV(oob));
    }
}

// M()

testPat(M("Number", number), "7.5 ", '7.5');

// cseq()

testPat(atom.X0, "1 2 3", '1 2 3');
testPat(cseq(atom), "1, 2, 3", '[1 2 3]');

// single-token atoms

testAtom("1.23", "1.23");
testAtom('"a\tb"', '(String "a\\tb")');
testAtom("ab_1", "ab_1");

// vector

testAtom("[]", '(Vector [])');
testAtom("[a]", '(Vector [a])');
testAtom("[a, b, c]", '(Vector [a b c])');
testAtom("[a ", '(Vector [a])', '(Error "CloseSquare")');
testAtom("[a,", '(Vector [a])', '(Error "CloseSquare")');

// map

testAtom("{}", '(Map [])');
testAtom("{a: A, b: B}", '(Map [a A b B])');
testAtom("{a: A,  ", '(Map [a A])', '(Error "CloseCurly")');
testAtom("{a:,}", '(Map [a (Missing)])');

// grouping

testAtom("(a)", "a");
testAtom("(a", "a", '(Error "CloseParen")');
testAtom("((a)) ", "a");

// Operator handling
let e = matchSuf(atom, or(dotSuffix, callSuffix, memberSuffix));
testPat(e, "a", "a");
testPat(e, "a.b", "(Dot a b)");

e = matchPre(atom, O("not"));
testPat(e, "not a", '(Unop "not" a)');

e = matchRTL(atom, O("^"));
testPat(e, "a ^ b ^ c", '(Binop "^" a (Binop "^" b c))');

e = matchLTR(atom, O("+"));
testPat(e, "a + b + c", '(Binop "+" (Binop "+" a b) c)');

e = matchRel(atom, O("<"));
testPat(e, "a", 'a', null);
testPat(e, "a < b", '(Binop "<" a b)');
testPat(e, "a < b < c", '(Binop "and" (Binop "<" a b) (Binop "<" b c))');

// ?:
testPat(ile, "a ? b : c", '(IIf a b c)');
testPat(ile, "a ? b : c ? d : e", '(IIf a b (IIf c d e))');

// ->
testPat(ile, "a -> (b, c) -> d", '(Fn [a] (Fn [b c] d))');

//================================
// LogLine
//================================

// atoms

testL("1.23", "1.23");
testL("(12)", "12");
testL("match X:\n  x => e\n", '(Match X [(S-Case x e)])');

// suffix operators

testL("a.b", '(Dot a b)');
testL("a.", '(Dot a (Missing))', '(Error "DotName")');
testL("a[1]", '(Index a 1)');
testL("a(1,x)", '(Call a [1 x])');
testL("a . b [ 1 ] ( 2 ) ",  '(Call (Index (Dot a b) 1) [2])');

// prefix

testL("-a", '(Unop "-" a)');

// LTR operators

testL("a+b-c", '(Binop "-" (Binop "+" a b) c)');

// precedence

testL("-3^b+c*d", '(Binop "+" (Unop "-" (Binop "^" 3 b)) (Binop "*" c d))');

// relational

testL("a==b", '(Binop "==" a b)');
testL("a<b<c", '(Binop "and" (Binop "<" a b) (Binop "<" b c))');

// ?:, $

testL("a or b ? f : g $ x", '(Binop "$" (IIf (Binop "or" a b) f g) x)');
testL("a ? x : b ? y : z",
      '(IIf a x (IIf b y z))');

// params -> expr

testL("()    -> 1", '(Fn [] 1)');
testL("(a)   -> 1", '(Fn [a] 1)');
testL("(a,b) -> 1", '(Fn [a b] 1)');
testL("a     -> 1", '(Fn [a] 1)');

//
// statements
//

testL("x = 1", '(S-Let x "=" 1)');
testL("x[1] := 1", '(S-Let (Index x 1) ":=" 1)');
testL("x.a := 1", '(S-Let (Dot x a) ":=" 1)');
testL("x := 1", '(S-Let x ":=" 1)');
testL("x <- a", '(S-Act [x] a)');
testL("x => e", '(S-Case x e)');
testL("if a: x", '(S-If a x)');
testL("loop:", '(S-Loop (MissingBlock))');
testL("loop:\n  if a: x\n  b\n", '(S-Loop [(S-If a x) b])');
testL("while c", '(S-While c)');
testL("loop while C:\n  x := 1\n", '(S-LoopWhile C [(S-Let x ":=" 1)])');
testL("for x in E: B", '(S-For x E B)');
testL("assert C", '(S-Assert C)');

// extraneous characters

testL("a b c", "a", '(Error "Garbage")');

// block body

testL("a + \n  x=1\n  x\n",
      '(Binop "+" a (Block [(S-Let x "=" 1) x]))');

// test `Module`

let t1 =
    '# C1\n' +
    'f = (x) ->\n' +
    '    if x < 1: 0\n' +
    '    x + 1\n' +
    '\n' +
    'f(2)\n';

testM(t1,
      '(Block [(S-Let f "=" ' +
      '(Fn [x] (Block [(S-If (Binop "<" x 1) 0) (Binop "+" x 1)]))' +
      ') (Call f [2])])',
      '(Comment "# C1")');

testM(
    ( 'loop:\n' +
      '  x += 1\n' +
      '  repeat\n' +
      'x\n'),
    '(Block [(S-Loop [(S-Let x "+=" 1) repeat]) x])');
