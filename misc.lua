-- Misc. utility functions
--

local test = require "test"
local concat = table.concat

-- MODIFIES `a`
--
local function override(a, b, c, ...)
   if b then
      for k, v in pairs(b) do
         a[k] = v
      end
      if c then
         return override(a, c, ...)
      end
   end
   return a
end

-- same as Lua 5.1.3's table.move
--
local function move(from, pstart, pend, at, to)
   to = to or from
   for n = pstart, pend do
      to[n + at - pstart] = from[n]
   end
   return to
end

-- Non-mutating functions...

local function clone(t)
   return override({}, t)
end

local function set(tbl, k, v)
   local o = override({}, tbl)
   o[k] = v
   return o
end

local function append(a, b)
   local o = {}
   move(a, 1, #a, 1, o)
   move(b, 1, #b, #a+1, o)
   return o
end

local function imap(t, fn)
   local o = {}
   for i, v in ipairs(t) do
      o[i] = fn(v)
   end
   return o
end

local function map(t, fn)
   local o = {}
   for k, v in pairs(t) do
      o[k] = fn(v)
   end
   return o
end

-- Return an array containing keys in `tbl` that are strings, sorted.
--
local function getSortedKeys(tbl)
   local keys = {}
   for k in pairs(tbl) do
      if type(k) == "string" then
         table.insert(keys, k)
      end
   end
   table.sort(keys)
   return keys
end

-- Iterate over elements with string keys, in order. Used as an alternative
-- to `pairs`.
local function pairsSorted(tbl)
   return next, getSortedKeys(tbl), nil
end

-- Serialize a Lua "record" value in an S-expression-like syntax.
--
--  * Tables where t.T == nil: Serialize t[1...] as a vector.
--        {1, 2, 3}           -->  "[1 2 3]"
--  * Tables where t.T ~= nil: Serialize as a list whose first element
--    is a symbol given by t.T, and subsequent elements are t[1...].
--        {T="Foo", 1, 2}     -->  "(Foo 1 2)"
--  * Other values: use test.serialize.
--
local function sexprFmt(nodeTop, formatters)
   local function format(node)
      if type(node) ~= "table" then
         return test.serialize(node)
      end

      local f = formatters and formatters[node.T or "[]"]
      if f then
         return f(node, format)
      end

      local elems = concat(imap(node, format), " ")
      if node.T then
         return "(" .. node.T .. (elems == "" and "" or " " .. elems) .. ")"
      else
         return "[" .. elems .. "]"
      end
   end
   return format(nodeTop)
end

local exports = {
   override = override,
   move = move,
   clone = clone,
   set = set,
   append = append,
   imap = imap,
   map = map,
   getSortedKeys = getSortedKeys,
   pairsSorted = pairsSorted,
   sexprFmt = sexprFmt,
}

if test.skip then
   return exports
end

local t = {a=1}
test.eq(set(t, "a", 2), {a=2})
test.eq(set(t, "b", 2), {a=1, b=2})
test.eq(t, {a=1})

test.eq({5,4,3,2,1}, exports.append({5,4}, {3,2,1}))

test.eq(sexprFmt({T="Foo", {"abc", 2, {T="Bar"}}}),
        '(Foo ["abc" 2 (Bar)])')

return exports
