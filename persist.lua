-- Utilities supporting persistent data structures
--

local test = require "test"


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
   for n = pstart, pend do
      to[n + at - pstart] = from[n]
   end
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


local exports = {
   override = override,
   move = move,
   clone = clone,
   set = set,
   append = append,
}


if test.skip then
   return exports
end


local t = {a=1}
test.eq(set(t, "a", 2), {a=2})
test.eq(set(t, "b", 2), {a=1, b=2})
test.eq(t, {a=1})

test.eq({5,4,3,2,1}, exports.append({5,4}, {3,2,1}))


return exports
