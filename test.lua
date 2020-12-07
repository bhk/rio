-- test.lua:  Unit testing utilities


-- Intercept and warn of global variable accesses.
--
local gmt = {
   __index = function (t, k) error("read of global " .. tostring(k), 2) end,
   __newindex = function (t, k) error("write to global " .. tostring(k), 2) end
}
setmetatable(_G, gmt)


-- Map a character to its Lua source escape sequence
local charEscapes = {
   ["\\"] = "\\\\",
   ["\""] = "\\\"",
   ["\n"] = "\\n",
   ["\r"] = "\\r",
   ["\t"] = "\\t",
}

local charEscapesMT = {}

function charEscapesMT:__index(c)
   local str = ("\\x%02X"):format(c:byte(1))
   self[c] = str
   return str
end

setmetatable(charEscapes, charEscapesMT)


-- Convert a value to Lua source that will re-create it, with the following
-- exceptions:
--
--  * Functions and userdata are serialized using `tostring`, which will not
--    emit valid Lua source, but will generate *unique* values for each
--    distinct function/userdata value.
--
--  * When a table appears more than once in the data structure, either in
--    circular data structures or not, occurrences after the first are
--    serialized as "@<N>", identifying the the Nth serialized table.
--
local function serialize(value)
   local visited = {}
   local visitIndex = 1

   local function ser(value)
      if type(value) == "string" then
         return "\"" .. value:gsub("[\0-\31\\\"\127-\255]", charEscapes) .. "\""
      elseif type(value) ~= "table" then
         return tostring(value)
      end

      if visited[value] then
         return visited[value]
      end
      visited[value] = "@" .. visitIndex
      visitIndex = visitIndex + 1

      local o = {}
      local ikeys = {}

      -- output ipairs
      for k, v in ipairs(value) do
         o[#o+1] = ser(v)
         ikeys[k] = true
      end

      -- Serialize non-ipairs keys so we can sort them
      local skeys = {}
      local skeyToValue = {}
      for k, v in pairs(value) do
         if ikeys[k] == nil then
            local sk = k
            if type(k) ~= "string" or not k:match("^[%a_][%a%d_]*$") then
               sk = "[" .. ser(k) .. "]"
            end
            skeys[#skeys+1] = sk
            skeyToValue[sk] = v
         end
      end
      table.sort(skeys)

      -- output other pairs
      for _, sk in ipairs(skeys) do
         o[#o+1] = sk .. "=" .. ser(skeyToValue[sk])
      end
      return "{" .. table.concat(o, ",") .. "}"
   end

   return ser(value)
end


-- Like `string.format` but also supports:
--    %Q  serializes the argument
--    %a  array elements, serialized and comma-separated
--
local function sprintf(fmt, ...)
   local args = {...}
   local nextIndex = 1
   local function printf_exp(info, char)
      if char == "%" then
         return "%"
      else
         local value = args[nextIndex]
         nextIndex = nextIndex + 1
         if char == "Q" then
            return serialize(value)
         elseif char == "a" then
            if type(value) ~= "table" then
               return "<not table>: " .. serialize(value)
            end
            local t = {}
            for index, elem in ipairs(value) do
               t[index] = serialize(elem)
            end
            return table.concat(t, ", ")
         else
            return string.format("%" .. info .. char, value)
         end
      end
   end

   local out = fmt:gsub("%%([%d%.]*)([%a%%])", printf_exp)
   return out
end


-- Write `sprintf(fmt, ...)` to stdout.
--
local function printf(fmt, ...)
   io.write(sprintf(fmt, ...))
end


local function failAt(level, fmt, ...)
   error(sprintf(fmt, ...), level+1)
end


local function fail(fmt, ...)
   return failAt(1, fmt, ...)
end

local function isEQ(a, b)
   return a == b or serialize(a) == serialize(b)
end


-- Verify that two equivalent arguments are passed, and indicate an error
-- (if any) at the calling function ancestor identified by `level`.
--
local function eqAt(level, a, b, ...)
   if select("#", ...) > 0 then
      failAt(level+1, "extraneous arguments: %a", {b, ...})
   end

   if a ~= b and serialize(a) ~= serialize(b) then
      failAt(level+1, "values not equal\n  A: %Q\n  B: %Q\n", a, b)
   end
end


-- Verify that eq() is passed exactly two equivalent arguments.
--
local function eq(...)
   return eqAt(1, ...)
end


-- Construct a file-like object supporting reads.  `data` gives the content
-- of the file to be mimiced.
--
local function mockFile(data)
   assert(data)
   local pos = 0
   local me = {}

   local function check(arg1)
      if arg1 ~= me then
         error("attempt to use wrong `self` value", 3)
      end
      if not data then
         error("attempt to use closed file", 3)
      end
   end

   function me:seek(whence, offset)
      check(self)
      local base = (whence == "set" and 0 or
                    whence == "end" and #data or
                       pos)
      pos = base + offset
      if pos < 0 then
         pos = 0
      elseif pos > #data then
         pos = #data
      end
      return pos
   end

   function me:read(size)
      check(self)
      if size == "a" then
         size = #data - pos
      elseif type(size) == "number" then
         assert(size >= 0)
      else
         assert(false, "read mode " .. size .. " not supported")
      end

      local oldPos = pos
      pos = pos + size
      if pos > #data then
         pos = #data
      end
      if oldPos >= pos then
         return nil
      end
      return data:sub(oldPos + 1, pos)
   end

   function me:close()
      check(self)
      data = nil
      return true
   end

   return me
end


-- Construct a table from a set of tables, containing all key/value pairs.
-- When two keys conflict in the provided tables, the last one "wins".
--
local function clone(...)
   local o = {}
   for n = 1, select("#", ...) do
      for k, v in pairs(select(n, ...) or {}) do
         o[k] = v
      end
   end
   return o
end


-- Return a table will all key/value pairs in INCL, except where a key is
-- found in EXCL.
--
local function subtract(incl, excl)
   local o = {}
   for k, v in pairs(incl) do
      if excl[k] == nil then
         o[k] = v
      end
   end
   return o
end

local isSkip = (os.getenv("RUN_TESTS") or "") == ""


local exports = {
   serialize = serialize,
   sprintf = sprintf,
   printf = printf,
   isEQ = isEQ,
   eq = eq,
   eqAt = eqAt,
   failAt = failAt,
   fail = fail,
   clone = clone,
   subtract = subtract,
   mockFile = mockFile,
   -- true => modules should skip tests
   skip = isSkip,
}


if isSkip then
   return exports
end


----------------------------------------------------------------
-- Tests
----------------------------------------------------------------


local function expectError(f, ...)
   local status, err = pcall(f, ...)
   if status then
      error("function did NOT fail.\n\n" .. tostring(err), 2)
   end
end

-- serialize

assert("1" == exports.serialize(1))
assert([["a"]] == exports.serialize("a"))
assert("{1,foo=2}" == exports.serialize({1,foo=2}))
assert("{[3]=7}" == exports.serialize({[3]=7}))

assert("\"a\\t\\r\\n\\\\\\\"\\x01\\x02\\xF3\\xFF\"" ==
          exports.serialize("a\t\r\n\\\"\x01\x02\xf3\xff"))


-- eq

eq(1, 1)
eq({}, {})
expectError(eq, 1, 2)
eq(eq, exports.eq)

-- clone

eq({a=1,b=2,c=3}, exports.clone({a=1,b=1}, {b=2,c=2}, {c=3}))

-- subtract

eq({a=1}, exports.subtract({a=1,b=2,c=3}, {b=false, c=1}))

-- mockFile

local f = exports.mockFile("abcdef")
eq("ab", f:read(2))
eq(nil, f:read(0))
eq("c", f:read(1))
eq(5, f:seek("cur", 2))
eq("f", f:read(3))
eq(nil, f:read(3))
eq(0, f:seek("set", 0))
eq(true, f:close())
expectError(f.read, f, 1)
expectError(f.seek, f, "set", 0)
expectError(f.close, f, 1)

-- sprintf

eq("1,2", exports.sprintf("%s,%d", 1, 2))
eq("< 4.500>", exports.sprintf("<%6.3f>", 4.5))
eq("a{1,2}", exports.sprintf("a%Q", {1,2}))
eq("a: 1, 2", exports.sprintf("a: %a", {1,2}))


return exports
