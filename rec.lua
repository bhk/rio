local test = require "test"
local persist = require "persist"

local concat = table.concat
local imap = persist.imap


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


test.eq(recFmt({type="Foo", {"abc", 2, {type="Bar"}}}),
        "(Foo ['abc' 2 (Bar)])")

return {
   rec = rec,
   recFmt = recFmt,
}
