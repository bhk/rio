-- Rio syntax parser
--
-- The result of parsing a module is a Block, which is an array of logical
-- lines, each of which is an expression or a statement.
--
-- Block: [ (expr | stmt)... ]
--
-- Expression:
--   (Name str)
--   (Missing)
--   (Number str)
--   (String str)
--   (Vector [expr...])
--   (Record [str expr ...])
--   (Fn [param...] body)
--   (Op op a b)
--   (Unop op a)
--   (Call fn args)
--   (Dot a name)
--   (Index a b)
--   (IIf a b c)
--   (Match value cases)
--   (Block block)
--
-- Statement:
--   (S-Let name op value)
--   (S-Act params act)
--   (S-Case pattern body)
--   (S-If cond then)
--   (S-Loop block)
--   (S-For name seq body)
--   (S-LoopWhile cond body)
--   (S-While cond)
--

local test = require "test"
local peg = require "peg"
local misc = require "misc"

local C, Cc, Ct, NoCaptures, NS, P, R, S, V =
   peg.C, peg.Cc, peg.Ct, peg.NoCaptures, peg.NS, peg.P, peg.R, peg.S, peg.V
local append, imap, move, override, set, sexprFormatter =
   misc.append, misc.imap, misc.move, misc.override, misc.set,
   misc.sexprFormatter

-- returns: match 0 or 1 occurrence of `p`
local function opt(p)
   return p + P(0)
end

----------------------------------------------------------------
-- 2D Syntax
----------------------------------------------------------------
--
-- The 2D grammar has dependencies on "inline" syntax patterns:
--
--    AtBlock: Succeeds when at a line (post-indent) that should be treated
--       as the beginning of a block.
--
--    Comment: Matches a comment, consuming characters to the terminating NL.
--
--    LogLine: Consumes a logical line, beginning at its first non-SPACE
--       character. LogLine must not read beyond LF characters except via
--       the 2D `nlBlock` and `nlWhite` patterns.  Also, it must consume all
--       everything up to `nlEOL`: every non-NL character, `nlWhite`, and
--       `nlBlock`.
--
-- 2D patterns only recognize two ASCII characters: LF and SPACE.  All other
-- characters are left to be handled by inline syntax patterns.
--
-- Empty lines (entirely whitespace or comments) are consumed by `nlWhite`,
-- so they are "seen" by LogLine as whitespace.
--

local NL = P"\n"
local SPACE = P" "
local EOF = -P(1)


-- Create a pattern that matches spaces *if* `cmp(indent, state.n)` is true.
--
local function matchIndent(cmp)
   local function m(subj, pos, state, g)
      local a, b = subj:find("^ *", pos)
      local indent = b - a + 1
      if cmp(indent, state.blockIndent) then
         state = set(state, "lineIndent", indent)
         return pos+indent, state, NoCaptures
      end
   end
   return P(m)
end


local indentGT = matchIndent(function (x, y) return x > y end)
local indentEQ = matchIndent(function (x, y) return x == y end)


-- Create a pattern that matches `pat` with `state.blockIndent` set to
-- `state.lineIndent`.
--
local function inBlock(pat)
   local function m(subj, pos, state, g)
      local prevN = state.blockIndent
      state = set(state, "blockIndent", state.lineIndent)
      local pos, state, caps = pat.match(subj, pos, state, g)
      if pos then
         return pos, set(state, "blockIndent", prevN), caps
      end
   end
   return P(m)
end


-- Match from start of a LogLine to NL at end of last LogLine
local blockBody = V"LogLine" * (NL * indentEQ * V"LogLine")^0
local nlBlank = NL * (SPACE^1 + V"Comment")^0 * #(NL + EOF)


-- Skip whitespace before content of first line
local p2dModule = (SPACE^1 + NL + V"Comment")^0 * blockBody


-- These patterns are provided for use by `LogLine`:
--
--   nlEOL: detects end of current logical line (doesn't consume)
--   nlWhite: consumes blank and all-comment lines to closing NL,
--      or consumes NL and indent before a continuation line.
--   nlBlock: consumes NL and a subsequent nested block.

local nlWhite = (nlBlank + NL * indentGT * -inBlock(V"AtBlock"))^1
local nlBlock = NL * indentGT * inBlock(#V"AtBlock" * blockBody)
local nlEOL = #(NL * -indentGT + EOF)


-- Initial parser state assumed by 2D parsing expressions
--
local p2dInitialState = {
   blockIndent = 0,
   oob = {}
}


--------------------------------
-- Inline Syntax
--------------------------------

local NonNL = NS"\n"


local cp = peg.cpos


-- Construct an AST node
local function Node(typ, pos, ...)
   return {T = typ, pos = pos, ...}
end


-- returns: match `pat` and construct a Node from its captures
local function N(typ, pat)
   return cp * pat / function (...) return Node(typ, ...) end
end


-- returns: match pat and append its captures to state.oob
local function Coob(pat)
   local function m(subj, pos, state)
      local pos, state, caps = pat.match(subj, pos, state)
      if pos then
         return pos, set(state, "oob", append(state.oob, caps)), NoCaptures
      end
   end
   return P(m)
end


-- returns: log an out-of-band error
local function E(desc)
   return Coob(N("Error", Cc(desc)))
end


local nameInitial = R("az", "AZ", "__")
local nameChar = R("az", "AZ", "__", "09")
local opChar = S"!#$%&'*+-./<=>?\\^`|~"
-- Remaining ASCII printables:  @{}():;,"

local comment = #P"#" * Coob(N("Comment", C(NonNL^0)))

-- skip whitespace
local controlChar = #R("\0\9", "\11\31") * E"BadChar" * 1
local ss = (S" "^1 + nlWhite + comment + controlChar)^0


local name = C(nameInitial * nameChar^0) * ss


-- returns: match and optionally capture any of a set of tokens
local function matchTokens(tokens, isCapture)
   local matchAny = nil
   for n, str in ipairs(tokens) do
      -- see what kind of token this is
      local kind = nameChar.match(str) and nameChar
         or opChar.match(str) and opChar
      local after = kind and (-kind * ss) or ss
      local pat = P(str) * (isCapture and Cc(str) * after or after)
      matchAny = matchAny and (matchAny + pat) or pat
   end
   return matchAny
end

-- returns: match a token
local function T(...)
   return matchTokens({...}, false)
end

-- returns: match and capture a token (used for Operators)
local function O(...)
   return matchTokens({...}, true)
end

-- Numeric literals

local digits = R"09" ^ 1
local number = C((digits * opt(P"." * (digits + E"NumDigitAfter"))
                     + #P"." * E"NumDigitBefore" * P"." * digits)
                    * opt(S"eE" * opt(S"+-") * digits))
   * (-(nameChar + ".") + E"NumEnd") * ss


-- String literals

local qchar = C(NS("\"\\\n")^1)
   + P"\\\\" * Cc("\\")
   + P"\\\"" * Cc("\"")
   + P"\\r" * Cc("\r")
   + P"\\n" * Cc("\n")
   + P"\\t" * Cc("\t")
   + E"StringBS" * P"\\" * Cc("\\")

local function concat(...)
   return table.concat{...}
end

local qstring = P"\"" * qchar^0 / concat * (P"\"" + E"StringEnd") * ss


-- match words not to be confused with variable names
local stmtKeywords = T("if", "loop", "while", "for", "assert")
local keywords = T("and", "or", "not", "match") + stmtKeywords


-- returns: match comma-delimited sequence of zero-or-more `p`
local function cseq(p)
   return Ct(p * (T"," * p)^0 * opt(T",") + P(0))
end


local nameNode = N("Name", name)

local variable = nameNode - keywords

local expr = V"Expr"
local needExpr = expr + N("Missing", P(0))

local vector = T"[" * cseq(expr) * (T"]" + E"CloseSquare")

local recordNV = nameNode * T":" * needExpr
local record = T"{" * cseq(recordNV) * (T"}" + E"CloseCurly")

local grouping = T"(" * needExpr * (T")" + E"CloseParen")

local needBlock = Ct(nlBlock) * ss + N("MissingBlock", P(0))

local atom =
   N("Number", number)
   + N("String", qstring)
   + variable
   + N("Vector", vector)
   + N("Record", record)
   + grouping
   + N("Block", Ct(nlBlock) * ss)
   + N("Match", T"match" * needExpr * T":" * needBlock)


local function binop(op, pos, a, b)
   return Node("Binop", pos, op, a, b)
end

-- left-associative operators
local function joinLTR(mergeOp)
   -- captures = expr (pos op expr)...
   return function (e, ...)
      for ii = 1, select("#", ...), 3 do
         local pos, op, param = select(ii, ...)
         e = mergeOp(op, pos, e, param)
      end
      return e
   end
end

local function matchLTR(e, pat)
   return e * (cp * pat * e)^0 / joinLTR(binop)
end

local function matchSuf(e, pat)
   return e * (cp * pat)^0 / joinLTR(Node)
end


-- right-associative binary operators
local function joinRTL(a, pos, op, ...)
   if op then
      return binop(op, pos, a, joinRTL(...))
   end
   return a
end

local function matchRTL(e, pat)
   return e * (cp * pat * e)^0 / joinRTL
end


-- unary prefix operators
local function joinPre(pos, op, ...)
   if op then
      return Node("Unop", pos, op, joinPre(...))
   end
   -- final capture is the expression
   return pos
end

local function matchPre(e, pat)
   return (cp * pat)^0 * e / joinPre
end


local function joinRel(e1, pos, op, e2, pos2, ...)
   if not pos then
      return e1
   end
   local rel = binop(op, pos, e1, e2)
   if not pos2 then
      return rel
   end
   return binop("and", pos, rel, joinRel(e2, pos2, ...))
end

local function matchRel(e, pat)
   return e * (cp * pat * e)^0 / joinRel
end


local function joinIIf(e1, pos, e2, e3, ...)
   if pos then
      return Node("IIf", pos, e1, e2, joinIIf(e3, ...))
   end
   return e1
end


local function joinFn(pos, params, ...)
   if not params then
      return pos
   end
   return Node("Fn", pos, params, joinFn(...))
end

-- Each suffix captures two values: nodeType & expr
local callSuffix = T"(" * Cc"Call" * cseq(expr) * (T")" + E"CloseParen")
local memberSuffix = T"[" * Cc"Index" * needExpr * (T"]" + E"CloseSquare")
local dotSuffix = T"." * Cc"Dot" * (nameNode + N("Missing", P(0)) * E"DotName")

local params = T"(" * cseq(variable) * T")" + Ct(variable)

local function addOperations(e)
   e = matchSuf(e, dotSuffix + callSuffix + memberSuffix)
   e = matchRTL(e, O("^"))
   e = matchPre(e, O("not", "-"))
   e = matchLTR(e, O("*", "/", "//", "%"))
   e = matchLTR(e, O("+", "-", "++"))
   e = matchRel(e, O("==", "!=", "<=", "<", ">=", ">"))
   e = matchLTR(e, O("and"))
   e = matchLTR(e, O("or"))
   e = e * (cp * T"?" * needExpr * (T":" + E"CloseIIf") * e)^0 / joinIIf
   e = matchRTL(e, O("$"))
   e = (cp * params * T"->")^0 * e / joinFn
   return e
end

local ile = addOperations(atom)


--------------------------------
-- Statements
--------------------------------

local letOp = O("=", ":=", "+=", "++=", "*=")

-- work around lua-mode.el indentation bug...
local Tif, Tfor, Twhile = T"if", T"for", T"while"

local letTarget = matchSuf(variable, dotSuffix + memberSuffix)

local pattern =
   variable
   + N("Number", number)
   + N("String", qstring)
   + N("VecPattern", T"[" * cseq(V"Pattern") * T"]")

local statement =
   N("S-Let", letTarget * letOp * needExpr)
   + N("S-Act", params * T"<-" * needExpr)
   + N("S-Case", pattern * T"=>" * needExpr)
   + N("S-If", Tif * expr * T":" * expr)
   + N("S-Loop", T"loop" * T":" * needBlock)
   + N("S-LoopWhile", T"loop" * Twhile * expr * T":" * needBlock)
   + N("S-While", Twhile * needExpr)
   + N("S-For", Tfor * variable * T"in" * expr * T":" * expr)
   + N("S-Assert", T"assert" * needExpr)

local atBlock = stmtKeywords
   + letTarget * letOp
   + params * T"<-"
   + pattern * T"=>"

-- consume everything to the end of the line
local discardEOL = E"Garbage" * (NonNL^1 + nlWhite + nlBlock)^0

local logLine =
   (#atBlock * (statement + N("BadStmt", P(0)))
       + (ss * ile + N("BadILE", P(0))))
   * (#nlEOL + discardEOL)

local rioModule = N("Block", Ct(p2dModule))

local rioG = {
   "Module",
   Module = rioModule,
   Comment = comment,
   AtBlock = atBlock,
   LogLine = logLine,
   Pattern = pattern,
   Expr = ile,
   Statement = statement,
}

local rioPat = P(rioG)


-- Parse a module's source code (given in `subj`).  Returns `node`, `oob`.
--   node = an AST node describing an expression
--   oob = an array of "out of band" captures (errors, comments)
--
local function parseModule(subj)
   local _, state, captures = rioPat.match(subj, 1, p2dInitialState)
   return captures[1], state.oob
end


--------------------------------
-- Create SEXPR summary of AST
--------------------------------

local astFmt = sexprFormatter {
   Name = function (v) return v[1] end,
   Number = function (v) return v[1] end,
}

local function astFmtV(nodes)
   return table.concat(imap(nodes, astFmt), " ")
end

local exports = {
   parseModule = parseModule,
   astFmtV = astFmtV,
   astFmt = astFmt,
}

if test.skip then
   return exports
end


----------------------------------------------------------------
-- Tests
----------------------------------------------------------------


--------------------------------
-- 2D Parsing Tests
--------------------------------


local function group(name)
   return function (...)
      return {name, ...}
   end
end


local text = C(NonNL^1)

local testAtBlock = T"if" + (name * ss * T"=")
local testLogLine = text * (nlWhite + text + nlBlock / group"B")^0 / group"L"
local testComment = P"#" * NonNL^0


-- Match `subj` using `pattern` in a grammar that supplies minimal "inline"
-- expressions.
--
local function testG(subj, pattern, ecaptures, eoob, epos)
   local g = {
      "top",
      top = pattern,
      AtBlock = testAtBlock,
      LogLine = testLogLine,
      Comment = testComment,
   }
   local pos, state, captures = P(g).match(subj, 1, p2dInitialState)

   test.eqAt(2, ecaptures, captures)
   test.eqAt(2, eoob or "", state and astFmtV(state.oob) or "")
   if epos then
      test.eqAt(2, epos, pos)
   end
end


testG("if a", testAtBlock, {}, nil, 4)
testG("\n  x = 1\n", nlWhite, nil)
testG("\n  x = 1\n", nlBlock, {{"L", "x = 1"}}, nil, 10)
testG("ile\n  x = 1\n", testLogLine, {{"L", "ile", {"B", {"L", "x = 1"}}}})
testG("abc\n  def\n", testLogLine, {{"L", "abc", "def"}})


local txt = [[if A:
    # c1
  # c2
# c3
  cont
if B:

  x = 1
  x
ile

]]


testG(txt, blockBody,
      { {"L", "if A:", "cont"},
        {"L", "if B:",
         {"B",
          {"L", "x = 1"},
          {"L", "x"}}},
        {"L", "ile"}})


--------------------------------
-- Inline Parsing Tests
--------------------------------

testG(" \nNext", ss, {}, nil, 2)
testG(" # c\n  x\n", ss, {}, '(Comment "# c")', 8)

testG("abc  ", O("abc"), {"abc"}, nil, 6)
testG("abc+ ", O("abc"), {"abc"}, nil, 4)
testG("abcd ", O("abc"), nil)

testG("+    ", O("+"), {"+"}, nil, 6)
testG("+a   ", O("+"), {"+"}, nil, 2)
testG("+()  ", O("+"), {"+"}, nil, 2)
testG("+=   ", O("+"), nil)

testG("()", number, nil)
testG(".", number, nil)
testG("7 ", number, {"7"}, nil, 3)
testG("7.5 ", number, {"7.5"})
testG("7.0e0 ", number, {"7.0e0"})
testG("7e+0 ", number, {"7e+0"})
testG("7.e+1 ", number, {"7.e+1"}, '(Error "NumDigitAfter")')
testG("7a ", number, {"7"}, '(Error "NumEnd")')
testG("1.23.", number, {"1.23"}, '(Error "NumEnd")')
testG(".5", number, {".5"}, '(Error "NumDigitBefore")')

testG([["a\\\t\nb"   ]], qstring, {"a\\\t\nb"}, nil, 14)
testG([["\a"]], qstring, {"\\a"}, '(Error "StringBS")')
testG([["abc]], qstring, {"abc"}, '(Error "StringEnd")')


-- Match `subj` using LogLine.
--
local function testL(subj, esexpr, eoob)
   local g = override({}, rioG, {"LogLine"})
   local pos, state, captures = P(g).match(subj, 1, p2dInitialState)
   test.eqAt(2, astFmtV(captures), esexpr)
   if eoob then
      test.eqAt(2, eoob, astFmtV(state.oob))
   end
end


-- Match `subj` using Module.
--
local function testM(subj, esexpr, eoob)
   local node, oob = parseModule(subj)
   test.eqAt(2, esexpr, astFmt(node))
   if eoob then
      test.eqAt(2, eoob, astFmtV(oob))
   end
end


-- tokens

testL("ab_1", "ab_1")
testL("1.23", "1.23")
testL('"a\tb"', '(String "a\\tb")')

-- errors

testL("\t x", "x", '(Error "BadChar")')

-- vector

testL("[]", '(Vector [])')
testL("[a]", '(Vector [a])')
testL("[a, b, c]", '(Vector [a b c])')
testL("[a ", '(Vector [a])', '(Error "CloseSquare")')
testL("[a,", '(Vector [a])', '(Error "CloseSquare")')

-- record

testL("{}", '(Record [])')
testL("{a: A, b: B}", '(Record [a A b B])')
testL("{a: A,  ", '(Record [a A])', '(Error "CloseCurly")')
testL("{a:,}", '(Record [a (Missing)])')

-- grouping

testL("(a)", "a")
testL("(a", "a", '(Error "CloseParen")')
testL("((a)) ", "a")

-- atoms

testL("1.23", "1.23")
testL("(12)", "12")
testL("match X:\n  x => e\n", '(Match X [(S-Case x e)])')

-- suffix operators

testL("a.b", '(Dot a b)')
testL("a.", '(Dot a (Missing))', '(Error "DotName")')
testL("a[1]", '(Index a 1)')
testL("a(1,x)", '(Call a [1 x])')
testL("a . b [ 1 ] ( 2 ) ",  '(Call (Index (Dot a b) 1) [2])')

-- RTL operator

testL("a^b^c", '(Binop "^" a (Binop "^" b c))')

-- prefix

testL("-a", '(Unop "-" a)')

-- LTR operators

testL("a+b-c", '(Binop "-" (Binop "+" a b) c)')

-- precedence

testL("-3^b+c*d", '(Binop "+" (Unop "-" (Binop "^" 3 b)) (Binop "*" c d))')

-- relational

testL("a==b", '(Binop "==" a b)')
testL("a<b<c", '(Binop "and" (Binop "<" a b) (Binop "<" b c))')

-- ?:, $

testL("a or b ? f : g $ x", '(Binop "$" (IIf (Binop "or" a b) f g) x)')
testL("a ? x : b ? y : z",
      '(IIf a x (IIf b y z))')

-- params -> expr

testL("()    -> 1", '(Fn [] 1)')
testL("(a)   -> 1", '(Fn [a] 1)')
testL("(a,b) -> 1", '(Fn [a b] 1)')
testL("a     -> 1", '(Fn [a] 1)')

--
-- statements
--

testL("x = 1", '(S-Let x "=" 1)')
testL("x[1] := 1", '(S-Let (Index x 1) ":=" 1)')
testL("x.a := 1", '(S-Let (Dot x a) ":=" 1)')
testL("x := 1", '(S-Let x ":=" 1)')
testL("x <- a", '(S-Act [x] a)')
testL("x => e:", '(S-Case x e)')
testL("if a: x", '(S-If a x)')
testL("loop:", '(S-Loop (MissingBlock))')
testL("loop:\n  if a: x\n  b\n", '(S-Loop [(S-If a x) b])')
testL("while c:", '(S-While c)')
testL("loop while C:\n  x := 1\n", '(S-LoopWhile C [(S-Let x ":=" 1)])')
testL("for x in E: B", '(S-For x E B)')
testL("assert C", '(S-Assert C)')

-- extraneous characters

testL("a b c", "a", '(Error "Garbage")')

-- block body

testL("a + \n  x=1\n  x\n",
      '(Binop "+" a (Block [(S-Let x "=" 1) x]))')

-- test `Module`

local t1 = [[
# C1
f = (x) ->
    if x < 1: 0
    x + 1

f(2)
]]

testM(t1, '(Block [(S-Let f "=" ' ..
         '(Fn [x] (Block [(S-If (Binop "<" x 1) 0) (Binop "+" x 1)]))' ..
         ') (Call f [2])])',
      '(Comment "# C1")')

testM([[
loop:
  x += 1
  repeat
x
]],
      '(Block [(S-Loop [(S-Let x "+=" 1) repeat]) x])')

return exports
