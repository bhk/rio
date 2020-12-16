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

-- Construct a table that will be serialized as an S-expression list.
--
local function rec(name, ...)
   return {type=name, ...}
end

-- Serialize a Lua value as an S-expression.  Tables are rendered as
-- S-expression lists when their `type` member is non-nil; otherwise they
-- are rendered as vectors (enclosed in square brackets).  Non-table values
-- are serialized normally.
--
local function recFmt(node, formatters)
   if type(node) == "string" then
      return "'" .. node:gsub("['\\]", "\\%1") .. "'"
   elseif type(node) ~= "table" then
      return test.serialize(node)
   end

   local function fmt(v)
      return recFmt(v, formatters)
   end

   local f = formatters and formatters[node.type or "[]"]
   if f then
      return f(node, fmt)
   end

   local elems = concat(imap(node, fmt), " ")
   if node.type then
      return "(" .. node.type .. (elems == "" and "" or " " .. elems) .. ")"
   else
      return "[" .. elems .. "]"
   end
end

local exports = {
   override = override,
   move = move,
   clone = clone,
   set = set,
   append = append,
   imap = imap,
   map = map,
   rec = rec,
   recFmt = recFmt,
}

if test.skip then
   return exports
end

local t = {a=1}
test.eq(set(t, "a", 2), {a=2})
test.eq(set(t, "b", 2), {a=1, b=2})
test.eq(t, {a=1})

test.eq({5,4,3,2,1}, exports.append({5,4}, {3,2,1}))

test.eq(recFmt({type="Foo", {"abc", 2, {type="Bar"}}}),
        "(Foo ['abc' 2 (Bar)])")

return exports
