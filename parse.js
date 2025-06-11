// parse: parse Rio source code

import { assert, set } from "./misc.js";
import { P, R, L } from "./ir/peg.js";
import { AST, astFmt, astFmtV } from "./ast.js";

const or = (...a) => P(a);
const S = (str) => P(str.split(""));

//==============================================================
// P2D: Parse 2D Syntax
//==============================================================
//
// P2D exports the following:
//
//   module: the top-level pattern, matches an entire Rio module.
//   atEOL: matches end of a logical line (doesn't consume).
//   white: consumes LF and next line's indentation if it is
//          a continuation line.
//   block: consumes LF and a subsequent block if it is nested
//          more deeply than the current line.
//
// It has dependencies on these "inline" syntax patterns:
//
//   atBlock: Succeeds at start of a line (post-indent) that should be
//            treated as the beginning of a block (versus continuation).
//   comment: Matches a comment, consuming characters to the terminating LF.
//   logLine: Consumes a logical line, beginning after indentation. It must
//            not read beyond LF characters except via the 2D `block` and
//            `white` patterns.  Also, it must consume everything up to
//            `atEOL`: every non-LF character, `white`, and `block`.
//
// 2D patterns only recognize two ASCII characters: LF and SP.  All other
// characters are left to be handled by inline syntax patterns.
//
// Empty lines (entirely whitespace or comments) are consumed by `white`,
// so they are "seen" by LogLine as whitespace.
//
// P2D uses PEG state, tracking indentation with `state.blockIndent`.

const LF = P("\n");
const SP = P(" ");
const EOF = P(1).not;

// Create a pattern that matches spaces *if* `cmp(indent, state.n)` is true.
//
const matchIndent = cmp => {
    return P((subj, pos, state, g) => {
        let indent = 0;
        while (subj[pos+indent] === ' ') {
            ++indent;
        }
        if (cmp(indent, state.blockIndent)) {
            state = set(state, "lineIndent", indent)
            return [pos + indent, [], state];
        }
    });
}

const indentGT = matchIndent( (x, y) => x > y );
const indentEQ = matchIndent( (x, y) => x === y );

// Create a pattern that matches `pat` with `state.blockIndent` set to
// `state.lineIndent`.
//
const inBlock = pat =>
      P((subj, pos, state) => {
          let prevN = state.blockIndent;
          state = set(state, "blockIndent", state.lineIndent);
          let result = pat.match(subj, pos, state);
          if (!result) {
              return false;
          }
          let [posOut, caps, stateOut] = result;
          return [posOut, caps, set(stateOut, "blockIndent", prevN)];
      });

const newP2D = ({comment, atBlock, logLine}) => {
    // Match from start of a logical line to LF at end of last logical line
    const blockBody = P(logLine, P(LF, indentEQ, logLine).x0);
    const nlBlank = P(LF, or(SP.x1, comment).x0, or(LF, EOF).at);

    const module = P(or(SP.x1, LF, comment).x0, blockBody)
    const white = or(nlBlank, P(LF, indentGT, inBlock(atBlock.not))).x1
    const block = P(LF, indentGT, inBlock(P(atBlock.at, blockBody)))
    const atEOL = or(P(LF, indentGT.not), EOF).at

    return { module, white, block, atEOL };
};

//==============================
// Inline Syntax
//==============================

// Return a pattern that matches `patterns`, constructs an AST Node of type
// `typ` from their captures, and "emits" it (puts it in captures or
// state.oob, depending on the type of node).
//
const CN = (typ, ...patterns) => {
    const p = P(...patterns);
    return P( (subj, pos, state) => {
        let result = p.match(subj, pos, state);
        if (!result) {
            return result;
        }
        let [posOut, caps, stateOut] = result;
        let node = AST[typ](...caps).setPos(pos, posOut);
        return AST.isOOB[typ]
            ? [posOut, [], set(stateOut, "oob", [...stateOut.oob, node])]
            : [posOut, [node], stateOut];
    });
};

// Return a pattern that emits an Error node (into state.oob)
const E = (desc, ...patterns) =>
      CN("Error", P().cc(desc), ...patterns);

const comment = P(P("#").at, CN("Comment", LF.non.x0.c));

const p2d = newP2D({
    comment,
    atBlock: L(_ => atBlock),
    logLine: L(_ => logLine)
});

//----------------------------------------------------------------

const nameInitial = R("az", "AZ", "__");
const nameChar = R("az", "AZ", "__", "09");
const opChar = S("!#$%&'*+-./<=>?\\^`|~");

// Skip whitespace
const controlChar = P(R("\x00\x09", "\x0b\x1f").at, E("BadChar", 1));
const ss = or(SP.x1, p2d.white, comment, controlChar).x0;

const name = P(P(nameInitial, nameChar.x0).c, ss);

// Return a pattern that matches any of a set of tokens, skips following
//   whitespace, and optionally captures the string.  Tokens are denoted by
//   strings, and to match must be terminated properly: name tokens must be
//   followed by non-name characters, operators by non-operator characters.
//   (Delimiters -- []{}():;,"@ -- can be followed by any character.)
//
const matchTokens = (tokens, isCapture) =>
      P(tokens.map( (str, index) =>
          P( (isCapture ? P(str).c : str),
             (nameChar.match(str, 0) ? nameChar.not :
              opChar.match(str, 0) ? opChar.not :
              0))),
          ss);

// Return a pattern that matches a token.
const T = (...tokenStrings) =>
      matchTokens([...tokenStrings], false);

// Return a pattern that matches and capture a token (used for Operators)
const O = (...tokenStrings) =>
      matchTokens([...tokenStrings], true);

// Numeric literals

const digits = R("09").x1;
const numberExp = P(S("eE"), S("+-").orNot, or(digits, E("NumDigitExp")));
// digits [`.` digits]
const numberA = P(digits, P(".", or(digits, E("NumDigitAfter"))).orNot);
// `.` digits    (accept, but flag as error)
const numberB = P(".", digits, E("NumDigitBefore"));

const number = P(
    P(or(numberA, numberB), numberExp.orNot).c,
    or(or(nameChar, ".").not, E("NumEnd")),
    ss);

// String literals

const qchars = or(
    S("\"\\\n").non.x1.c,
    P("\\\\").cc("\\"),
    P("\\\"").cc("\""),
    P("\\r").cc("\r"),
    P("\\n").cc("\n"),
    P("\\t").cc("\t"),
    P("\\", E("StringBS")).cc("\\") ).x0.cf(caps => [caps.join("")]);

const qstring = P('"', qchars, or('"', E("StringEnd")), ss);

// Keywords are not to be confused with variable names
const stmtKeywords = T("if", "loop", "while", "for", "assert");
const keywords = or(T("and", "or", "not", "match"), stmtKeywords);

// Match comma-delimited sequence of zero-or-more `p`
const cseq = p =>
      P(p, P(T(","), p).x0, T(",").orNot).orNot.ca();

const nameNode = CN("Name", name);

const variable = P(keywords.not, nameNode);

const expr = L(_ => _expr);
const needExpr = or(expr, CN("Missing"));

const vector = P(T("["), cseq(expr), or(T("]"), E("CloseSquare")));

const mapNV = P(nameNode, T(":"), needExpr);
const map = P(T("{"), cseq(mapNV), or(T("}"), E("CloseCurly")));

const grouping = P(T("("), needExpr, or(T(")"), E("CloseParen")));

const needBlock = or(p2d.block.ca(), CN("MissingBlock"));

const atom = or(
    CN("Number", number),
    CN("String", qstring),
    variable,
    CN("Vector", vector),
    CN("Map", map),
    grouping,
    CN("Block", p2d.block.ca()),
    CN("Match", T("match"), needExpr, T(":"), needBlock));

//----------------------------------------------------------------
// Parse operator expressions (binary, unary, and ternary)
//----------------------------------------------------------------

const binop = (op, a, b) => AST.Binop(op, a, b).setPos(a.pos, b.end);

const binopMerge = (a, op, b) => binop(op, a, b);

const sufMerge = (a, typ, b, end) => AST[typ](a, b).setPos(a.pos, end);

// left-associative operators
const joinLTR = mergeOp => captures => {
    let [e, ...others] = captures;
    for (const other of others) {
        e = mergeOp(e, ...other);
    }
    return [e];
};

const matchLTR = (e, pat) =>
      P(e, P(pat, e).ca().x0).cf(joinLTR(binopMerge));

const matchSuf = (e, pat) =>
      P(e, P(pat, P().cpos).ca().x0).cf(joinLTR(sufMerge));

// right-associative binary operators
const joinRTL = captures => {
    const [a, pos, op, ...others] = captures;
    if (op) {
        return [binop(op, a, ...joinRTL(others))];
    }
    return [a];
};

const matchRTL = (e, pat) =>
      P(e, P(pat, e).cpos.x0).cf(joinRTL);

// unary prefix operators
const joinPre = captures => {
    const [pos, op, ...others] = captures;
    if (op) {
        const expr = joinPre(others);
        return AST.Unop(op, expr).setPos(pos, expr.end);
    }
    // final capture is the expression
    return pos;
};

const matchPre = (e, pat) =>
      P(pat.cpos.x0, e).cf(caps => [joinPre(caps)]);

const joinRel = captures => {
    const [e1, pos, op, e2, pos2, ...others] = captures;
    if (pos == undefined) {
        return [e1];
    }
    const rel = binop(op, e1, e2);
    if (pos2 == undefined) {
        return [rel];
    }
    return [binop("and", rel, ...joinRel([e2, pos2, ...others]))];
};

const matchRel = (e, pat) =>
      P(e, P(pat, e).cpos.x0).cf(joinRel);

const joinIIf = captures => {
    const [e1, pos, e2, e3, ...others] = captures;
    if (pos == undefined) {
        return e1;
    }
    const k = joinIIf([e3, ...others]);
    return AST.IIf(e1, e2, k).setPos(pos, k.end);
};

// Each suffix captures two values: nodeType & expr/arglist
const callSuffix =
    P(T("(").cc("Call"), cseq(expr), or(T(")"), E("CloseParen")));
const memberSuffix =
    P(T("[").cc("Index"), needExpr, or(T("]"), E("CloseSquare")));
const dotSuffix =
    P(T(".").cc("Dot"), or(nameNode, P(CN("Missing"), E("DotName"))));

const params = or(P(T("("), cseq(variable), T(")")), variable.ca());

const combineOps = () => {
    let e = atom;
    e = matchSuf(e, or(dotSuffix, callSuffix, memberSuffix));
    e = matchRTL(e, O("^"));
    e = matchPre(e, O("not", "-"));
    e = matchLTR(e, O("*", "/", "//", "%"));
    e = matchLTR(e, O("+", "-", "++"));
    e = matchRel(e, O("==", "!=", "<=", "<", ">=", ">"));
    e = matchLTR(e, O("and"));
    e = matchLTR(e, O("or"));
    e = P(e, P(T("?"), needExpr, or(T(":"), E("CloseIIf")), e).cpos.x0)
        .cf(caps => [joinIIf(caps)]);
    e = matchRTL(e, O("$"));
    e = or([ CN("Fn", params, T("->"), needExpr), e ]);
    return e;
};

const _expr = combineOps();

//==============================
// Statements
//==============================

const letOp = O("=", ":=", "+=", "++=", "*=");

const letTarget = matchSuf(variable, or(dotSuffix, memberSuffix))

const pattern = or(
    variable,
    CN("Number", number),
    CN("String", qstring),
    CN("VecPattern", T("["), cseq(L(_ => pattern)), T("]")));

const statement = or(
    CN("SLet", letTarget, letOp, needExpr),
    CN("SAct", params, T("<-"), needExpr),
    CN("SCase", pattern, T("=>"), needExpr),
    CN("SIf", T("if"), _expr, T(":"), _expr),
    CN("SLoop", T("loop"), T(":"), needBlock),
    CN("SLoopWhile", T("loop"), T("while"), _expr, T(":"), needBlock),
    CN("SWhile", T("while"), needExpr),
    CN("SFor", T("for"), variable, T("in"), _expr, T(":"), _expr),
    CN("SAssert", T("assert"), needExpr));

const atBlock = or(
    stmtKeywords,
    P(letTarget, letOp),
    P(params, T("<-")),
    P(pattern, T("=>")));

// consume everything to the end of the line
const discardEOL = E("Garbage", or(LF.non.x1, p2d.white, p2d.block).x1);

const logLine = P(
    or( P(atBlock.at, or(statement, CN("BadStmt"))),
        P(ss, _expr),
        CN("BadILE")),
    or(p2d.atEOL.at, discardEOL));

const rioModule = CN("Block", p2d.module.ca());

const initialState = {
    blockIndent: 0,   // use by P2D
    oob: [],          // used by cOOB for "out of band" captures
};

// Parse a module's source code (given in `subj`).  Returns [`node`, `oob`].
//   node = an AST node describing an expression
//   oob = an array of "out of band" captures (errors, comments)
//
// The result of parsing a module is a Block, which is an array of logical
// lines, each of which is an expression or a statement.
//
const parseModule = subj => {
    const [_, captures, state] = rioModule.match(subj, 0, initialState);
    return [captures[0], state.oob];
};

export { parseModule };

//==============================================================
// Tests
//==============================================================

import test from "./ir/test.js";
const { eq, eqAt } = test;

const fail = P([]);

// Match `subj` using `pattern`.
//   ecaptures = false => expect failure
//               array => expected captures
//               string => serialization
//
const pt = (pattern, subj, ecaptures, eoob, epos, level) => {
    level = (level || 1) + 1;
    const results = pattern.match(subj, 0, initialState);
    if (ecaptures === false) {
        eqAt(level, false, results);
        return;
    }
    const [pos, captures, state] = results;
    eqAt(level, ecaptures, (Array.isArray(ecaptures) ? captures :
                            astFmtV(captures)));
    eqAt(level, eoob || "", astFmtV(state.oob));
    if (epos !== undefined) {
        eqAt(level, epos, pos);
    }
};

//==============================
// 2D Parsing Tests
//==============================

// Instantiate P2D with a minimal set of inline patterns:
//   - begin blocks only at "if ..." or "NAME = ..."
//   - logical lines contain arbitrary text and/or nested blocks
//   - use S-expr captures:  ["B", ...] for blocks, ["L", ...] for lines.
//
const t2d = newP2D({
    atBlock: L(_ => t2d_atBlock),
    comment: L(_ => t2d_comment),
    logLine: L(_ => t2d_logLine)
});

const t2d_atBlock = or(T("if"), P(name, ss, T("=")));
const t2d_comment = P("#", LF.non.x0);
const t2d_logLine = P(LF.non.x1.c, or(t2d.white, LF.non.x1.c,
                                      t2d.block.ca("B")).x0).ca("L");

pt(t2d.white, "\n  x = 1\n", false);
pt(t2d.block, "\n  x = 1\n", [["L", "x = 1"]], null, 9);
pt(t2d_atBlock, "if a", [], null, 3);
pt(t2d_logLine, "ile\n  x = 1\n",
   [["L", "ile", ["B", ["L", "x = 1"]]]]);
pt(t2d_logLine, "abc\n  def\n",
   [["L", "abc", "def"]])

pt(t2d.module,
   [
       'if A:',
       '    # c1',
       '  # c2',
       '# c3',
       '  cont',
       'if B:',
       '',
       '  x = 1',
       '  x',
       'ile',
       ''
   ].join("\n"),
   [ ["L", "if A:", "cont"],
     ["L", "if B:",
      ["B",
       ["L", "x = 1"],
       ["L", "x"]]],
     ["L", "ile"]]);

//==============================
// Inline Parsing Tests
//==============================

eq(astFmt(AST.Name("x")), 'x');
eq(astFmt(AST.Number("9")), '9');

eq(CN("Name", P("b").c).match("abc", 1, {}, {}),
   [2, [AST.Name("b").setPos(1, 2)], {}]);

eq([1, [], initialState],
   ss.match(" \nx", 0, initialState, {Comment: fail}));

pt(ss, " \nNext", [], null, 1);
pt(ss, " # c\n  x\n", [], '(Comment "# c")', 7);
pt(ss, "\t x", [], '(Error "BadChar")', 2);

pt(O("abc"), "abc  ", ["abc"], null, 5);
pt(O("abc"), "abc+ ", ["abc"], null, 3);
pt(O("abc"), "abcd ", false);

pt(O("+"), "+    ", ["+"], null, 5);
pt(O("+"), "+a   ", ["+"], null, 1);
pt(O("+"), "+()  ", ["+"], null, 1);
pt(O("+"), "+=   ", false);

pt(number, "()", false);
pt(number, ".", false);
pt(number, "7 ", ["7"], null, 2);
pt(number, "7.5 ", ["7.5"]);
pt(number, "7.0e0 ", ["7.0e0"]);
pt(number, "7e+0 ", ["7e+0"]);
pt(number, "7.e+1 ", ["7.e+1"], '(Error "NumDigitAfter")');
pt(number, "7a ", ["7"], '(Error "NumEnd")');
pt(number, "1.23.", ["1.23"], '(Error "NumEnd")');
pt(number, ".5", [".5"], '(Error "NumDigitBefore")');

pt(qstring, '"a\\\\\\t\\nb"   ', ["a\\\t\nb"], null, 13);
pt(qstring, '"\\a"', ["\\a"], '(Error "StringBS")');
pt(qstring, '"abc', ["abc"], '(Error "StringEnd")');

// CN()

pt(CN("Number", number), "7.5 ", '7.5');

// cseq()

pt(atom.x0, "1 2 3", '1 2 3');
pt(cseq(atom), "1, 2, 3", '[1 2 3]');

// single-token atoms

pt(atom, "1.23", "1.23");
pt(atom, '"a\tb"', '(String "a\\tb")');
pt(atom, "ab_1", "ab_1");

// vector

pt(atom, "[]", '(Vector [])');
pt(atom, "[a]", '(Vector [a])');
pt(atom, "[a, b, c]", '(Vector [a b c])');
pt(atom, "[a ", '(Vector [a])', '(Error "CloseSquare")');
pt(atom, "[a,", '(Vector [a])', '(Error "CloseSquare")');

// map

pt(atom, "{}", '(Map [])');
pt(atom, "{a: A, b: B}", '(Map [a A b B])');
pt(atom, "{a: A,  ", '(Map [a A])', '(Error "CloseCurly")');
pt(atom, "{a:,}", '(Map [a (Missing)])');

// grouping

pt(atom, "(a)", "a");
pt(atom, "(a", "a", '(Error "CloseParen")');
pt(atom, "((a)) ", "a");

// Operator handling
let e = matchSuf(atom, or(dotSuffix, callSuffix, memberSuffix));
pt(e, "a", "a");
pt(e, "a.b", "(Dot a b)");

e = matchPre(atom, O("not"));
pt(e, "not a", '(Unop "not" a)');

e = matchRTL(atom, O("^"));
pt(e, "a ^ b ^ c", '(Binop "^" a (Binop "^" b c))');

e = matchLTR(atom, O("+"));
pt(e, "a + b + c", '(Binop "+" (Binop "+" a b) c)');

e = matchRel(atom, O("<"));
pt(e, "a", 'a', null);
pt(e, "a < b", '(Binop "<" a b)');
pt(e, "a < b < c", '(Binop "and" (Binop "<" a b) (Binop "<" b c))');

// ?:
pt(expr, "a ? b : c", '(IIf a b c)');
pt(expr, "a ? b : c ? d : e", '(IIf a b (IIf c d e))');

// ->
pt(expr, "a -> (b, c) -> d", '(Fn [a] (Fn [b c] d))');

//================================
// LogLine
//================================

const ptLL = (subj, eser, eoob, epos) =>
    pt(logLine, subj, eser, eoob, epos, 2);

// atoms

ptLL("1.23", "1.23");
ptLL("(12)", "12");
ptLL("match X:\n  x => e\n", '(Match X [(S-Case x e)])');

// suffix operators

ptLL("a.b", '(Dot a b)');
ptLL("a.", '(Dot a (Missing))', '(Error "DotName")');
ptLL("a[1]", '(Index a 1)');
ptLL("a(1,x)", '(Call a [1 x])');
ptLL("a . b [ 1 ] ( 2 ) ",  '(Call (Index (Dot a b) 1) [2])');

// prefix

ptLL("-a", '(Unop "-" a)');

// LTR operators

ptLL("a+b-c", '(Binop "-" (Binop "+" a b) c)');

// precedence

ptLL("-3^b+c*d", '(Binop "+" (Unop "-" (Binop "^" 3 b)) (Binop "*" c d))');

// relational

ptLL("a==b", '(Binop "==" a b)');
ptLL("a<b<c", '(Binop "and" (Binop "<" a b) (Binop "<" b c))');

// ?:, $

ptLL("a or b ? f : g $ x", '(Binop "$" (IIf (Binop "or" a b) f g) x)');
ptLL("a ? x : b ? y : z",
      '(IIf a x (IIf b y z))');

// params -> expr

ptLL("()    -> 1", '(Fn [] 1)');
ptLL("(a)   -> 1", '(Fn [a] 1)');
ptLL("(a,b) -> 1", '(Fn [a b] 1)');
ptLL("a     -> 1", '(Fn [a] 1)');

//
// statements
//

ptLL("x = 1", '(S-Let x "=" 1)');
ptLL("x[1] := 1", '(S-Let (Index x 1) ":=" 1)');
ptLL("x.a := 1", '(S-Let (Dot x a) ":=" 1)');
ptLL("x := 1", '(S-Let x ":=" 1)');
ptLL("x <- a", '(S-Act [x] a)');
ptLL("x => e", '(S-Case x e)');
ptLL("if a: x", '(S-If a x)');
ptLL("loop:", '(S-Loop (MissingBlock))');
ptLL("loop:\n  if a: x\n  b\n", '(S-Loop [(S-If a x) b])');
ptLL("while c", '(S-While c)');
ptLL("loop while C:\n  x := 1\n", '(S-LoopWhile C [(S-Let x ":=" 1)])');
ptLL("for x in E: B", '(S-For x E B)');
ptLL("assert C", '(S-Assert C)');

// extraneous characters

ptLL("a b c", "a", '(Error "Garbage")');

// block body

ptLL("a + \n  x=1\n  x\n",
     '(Binop "+" a (Block [(S-Let x "=" 1) x]))');

// test `parseModule`

const ptM = (subj, eser, eoob) => {
    const [node, oob] = parseModule(subj);
    eqAt(2, eser, astFmt(node));
    if (eoob) {
        eqAt(2, eoob, astFmtV(oob));
    }
};

const t1 =
    '# C1\n' +
    'f = (x) ->\n' +
    '    if x < 1: 0\n' +
    '    x + 1\n' +
    '\n' +
    'f(2)\n';

ptM(t1,
    '(Block [(S-Let f "=" ' +
    '(Fn [x] (Block [(S-If (Binop "<" x 1) 0) (Binop "+" x 1)]))' +
    ') (Call f [2])])',
    '(Comment "# C1")');

ptM(( 'loop:\n' +
      '  x += 1\n' +
      '  repeat\n' +
      'x\n'),
    '(Block [(S-Loop [(S-Let x "+=" 1) repeat]) x])');
