-- PEG combinator library supporting stateful parsing.  Patterns implement:
--
--     match: (subject, pos, state, g) --> (pos, state, captures)
--
-- Patterns can be composed using the following operators and functions,
-- mostly as in LPEG.  Instead of lpeg.match(pattern, text), use
-- pattern.match(text, pos, state).
--
--    P(string | number | function | pattern | table)
--    S(string)
--    R(pairs...)
--    V(name)
--    p^n
--    p * q
--    p + q
--    p - q
--    -p
--    #p
--    p / function         function: values... -> values...
--    C(p)
--    Ct(p)
--    Cc(caps)
--    cpos                 cpos is like lpeg.Cp(), not lpeg.Cp
--
-- Also:
--    Plua(luapat): PEG pattern that matches a Lua pattern
--    NS(string): match any character *except* those in string
--
-- Note: LPEG does not support stateful parsing explicitly, and it disallows
-- loops that can consume no input (it doesn't know what the `Cmt` is
-- doing).

local test = require "test"
local misc = require "misc"

local append = misc.append


-- Note: quote ']' so the result can be used in [...] contexts.
local magicChars = ("^$()%.[]*+-?"):gsub(".", "%%%1")

local function patEscape(str)
   return ( str:gsub("[" .. magicChars .. "]", "%%%1") )
end


local NoCaptures = {}


-- We use `nil` to represent an empty set of captures.
--
local function appendCaptures(a, b)
   if a == NoCaptures then
      return b
   elseif b == NoCaptures then
      return a
   end
   return append(a or {}, b or {})
end


local Pattern = {}


local function Pfn(match)
   return setmetatable({match = match}, Pattern)
end


-- always succeeds
--
local empty = Pfn(function (subj, pos, state, g)
                     return pos, state, NoCaptures end)


-- always fails
--
local fail = Pfn(function (subj, pos, state, g) end)



local function Plua(pat)
   local anchoredPat = "^" .. pat
   --test.printf("pat = %q\n", anchoredPat)
   local function m(subj, pos, state, g)
      --print("--> ", anchoredPat)
      local a, b = subj:find(anchoredPat, pos)
      if a then
         return b+1, state, NoCaptures
      end
   end
   return Pfn(m)
end


local function Pg(g)
   local initial = g[g[1]]
   if not initial then
      error("grammar missing intial pattern `" .. tostring(g[1]) .. "`")
   end
   local function m(subj, pos, state, _)
      return initial.match(subj, pos, state, g)
   end
   return Pfn(m)
end


local function Pstr(str)
   return Plua(patEscape(str))
end


local function Pnum(n)
   if n == 0 then
      return empty
   end
   local function m(subj, pos, state, _)
      if pos + n <= #subj + 1 then
         return pos+n, state, NoCaptures
      end
   end
   return Pfn(m)
end


local function P(value)
   if type(value) == "string" then
      return Pstr(value)
   elseif type(value) == "number" then
      return Pnum(value)
   elseif type(value) == "function" then
      return Pfn(value)
   elseif type(value) == "table" then
      if getmetatable(value) == Pattern then
         return value
      end
      return Pg(value)
   end
   error("bad argument to peg.P: " .. tostring(value))
end


-- a * b  =>  sequence
--
function Pattern.__mul(a, b)
   a = P(a)
   b = P(b)
   local function m(subj, pos, state, g)
      local pos, state, caps = a.match(subj, pos, state, g)
      if not pos then
         return
      end
      local pos, state, caps_b = b.match(subj, pos, state, g)
      if not pos then
         return
      end
      return pos, state, appendCaptures(caps, caps_b)
   end
   return Pfn(m)
end


-- a + b  =>  ordered choice
--
function Pattern.__add(a, b)
   a = P(a)
   b = P(b)
   local function m(subj, pos, state, g)
      local apos, astate, acaptures = a.match(subj, pos, state, g)
      if apos then
         return apos, astate, acaptures
      end
      return b.match(subj, pos, state, g)
   end
   return Pfn(m)
end


-- #p  =>  lookahead
--
function Pattern:__len()
   local function m(subj, pos, state, g)
      if self.match(subj, pos, state, g) then
         return pos, state, NoCaptures
      end
   end
   return Pfn(m)
end


-- -p  =>  negative lookahead
--
function Pattern:__unm()
   local function m(subj, pos, state, g)
      if not self.match(subj, pos, state, g) then
         return pos, state, NoCaptures
      end
   end
   return Pfn(m)
end


-- p^n  =>  match at least `n` repetitions of `p`
--
function Pattern:__pow(n)
   assert(n >= 0)
   local function m(subj, pos, state, g)
      local count = -1
      local caps = NoCaptures
      local capsOut = NoCaptures
      local posOut, stateOut
      while pos do
         posOut, stateOut, capsOut = pos, state, appendCaptures(capsOut, caps)
         count = count + 1
         pos, state, caps = self.match(subj, pos, state, g)
      end
      if count >= n then
         return posOut, stateOut, capsOut
      end
      return nil
   end
   return Pfn(m)
end


function Pattern:__div(fn)
   local function m(subj, pos, state, g)
      local caps
      pos, state, caps = self.match(subj, pos, state, g)
      if pos then
         return pos, state, {fn(table.unpack(caps))}
      end
   end
   return Pfn(m)
end


function Pattern.__sub(a, b)
   a = P(a)
   b = P(b)
   return -b * a
end


--   cp       =>  captures = { pos }
--
local cp = Pfn(function (subj, pos, state, g) return pos, state, {pos} end)


--   Cc(caps...)    =>  captures = { caps... }
--
local function Cc(...)
   local caps = { ... }
   return Pfn(function (subj, pos, state, g) return pos, state, caps end)
end


--   C(p)     =>  captures = { ...caps(p)..., matched_text }
--
local function C(p)
   local match = P(p).match
   local function m(subj, posStart, state, g)
      local pos, state, caps = match(subj, posStart, state, g)
      if pos then
         return pos, state, appendCaptures(caps, { subj:sub(posStart, pos-1) })
      end
   end
   return Pfn(m)
end


--   Ct(p)    =>  captures = { {...caps(p)...} }
--
local function Ct(p)
   local match = P(p).match
   local function m(subj, posStart, state, g)
      local pos, state, caps = match(subj, posStart, state, g)
      if pos then
         return pos, state, { caps or {} }
      end
   end
   return Pfn(m)
end


local function R(...)
   local ranges = {...}
   for ndx, pair in ipairs(ranges) do
      test.eq(#pair, 2)
      local a, b = pair:sub(1,1), pair:sub(2,2)
      test.eq(true, a <= b)
      ranges[ndx] = patEscape(a) .. "-" .. patEscape(b)
   end
   return Plua("[" .. table.concat(ranges) .. "]")
end


local function S(chars)
   if #chars == 0 then
      return fail
   end
   return Plua("[" .. patEscape(chars) .. "]")
end


local function NS(chars)
   if #chars == 0 then
      return fail
   end
   return Plua("[^" .. patEscape(chars) .. "]")
end


local function V(name)
   local function m(subj, pos, state, g)
      local p = g[name]
      if type(p) ~= "table" then
         error("undefined non-terminal " .. tostring(name))
      end
      return p.match(subj, pos, state, g)
   end
   return Pfn(m)
end


local exports = {
   P = P,
   Plua = Plua,
   R = R,
   S = S,
   NS = NS,
   V = V,
   C = C,
   Cc = Cc,
   Ct = Ct,
   cpos = cp,
   NoCaptures = NoCaptures,
}


if test.skip then
   return exports
end


----------------------------------------------------------------
-- tests
----------------------------------------------------------------

local function checkPat(str, pat, pos, ...)
   local captures = {...}
   local expected = pos and {pos, {}, captures} or {}
   local out = { pat.match(str, 1, {}) }
   test.eqAt(2, out, expected)
end


local function CoP(s) return C(P(s)) end


checkPat("xyz", fail, nil)

checkPat("xyz", empty, 1)

checkPat("xyz", P"xy", 3)
checkPat("xyz", P"y", nil)
checkPat("xyz", P"", 1)

checkPat("xyz", cp, 1, 1)
checkPat("xyz", Cc("A", "B"), 1, "A", "B")
checkPat("xyz", CoP"x", 2, "x")
checkPat("xyz", Ct(CoP"x" * CoP"y"), 3, {"x", "y"})

checkPat("xyz", P"x" + P"y", 2)
checkPat("xyz", P"y" + P"x", 2)
checkPat("xyz", CoP"y" + CoP"x", 2, "x")

checkPat("xyz", P"x" * P"y", 3)
checkPat("xyz", P"x" * "y", 3)
checkPat("xyz", P"x" * P"z", nil)
checkPat("xyz", CoP"x" * CoP"y", 3, "x", "y")

checkPat("xyz", P"y" ^ 0, 1)
checkPat("xxy", P"x" ^ 0, 3)
checkPat("xxy", P"x" ^ 1, 3)
checkPat("xxy", P"x" ^ 3)
checkPat("xxy", CoP"x" ^ 0, 3, "x", "x")

checkPat("xyz", P(0), 1)
checkPat("xyz", P(1), 2)
checkPat("xyz", P(3), 4)
checkPat("xyz", P(4), nil)

checkPat("xyz", #P"x", 1)
checkPat("xyz", #P"y", nil)

checkPat("xyz", -P"x", nil)
checkPat("xyz", -P"a", 1)

checkPat("xyz", P"x" - P"xy", nil)
checkPat("xyz", P"x" - P"xz", 2)

checkPat("xyz", S"AxB", 2)
checkPat("xyz", S"", nil)

checkPat("xyz", NS"x", nil)
checkPat("xyz", NS"z", 2)
checkPat("xyz", NS"z"^0, 3)

checkPat("xyz", R"ax", 2)
checkPat("xyz", R"aw", nil)
checkPat("xyz", R("ab", "xy")^0, 3)

-- p / fn

checkPat("xyz", C(Plua"."), 2, "x")
checkPat("xyz", C(Plua".") / function (c) return "@"..c end,
          2, "@x")


-- grammar

checkPat("xyz", P{"Top", Top=V"A", A=C(P"x")}, 2, "x")
checkPat("xyz", P{"Top", Top=P"x" * V"A", A=C(P"y")}, 3, "y")


-- state

-- if n > 0, succeed, decrement N, and return old N
local function fdec(subj, pos, st)
   local n = st.n
   if n > 0 then
      return pos, {n = n-1}, {n}
   end
end
local dec = P(fdec)


test.eq( {dec.match("", 1, {n=0})}, {})
test.eq( {dec.match("", 1, {n=1})}, {1, {n=0}, {1}})
test.eq( {(P"x" + dec + "z").match("", 1, {n=1})}, {1, {n=0}, {1}})
test.eq( {(dec^0).match("", 1, {n=3})},
         {1, {n=0}, {3, 2, 1}})

return exports
