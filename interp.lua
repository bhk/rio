-- Rio interpreter

local test = require "test"
local syntax = require "syntax"
local persist = require "persist"
local reclib = require "rec"

local map, imap, clone, move, override = persist.map, persist.imap,
    persist.clone, persist.move, persist.override
local astFmt, astFmtV = syntax.astFmt, syntax.astFmtV
local concat, unpack = table.concat, table.unpack
local rec, recFmt = reclib.rec, reclib.recFmt

----------------------------------------------------------------
-- Environments
----------------------------------------------------------------

-- An environment, as used in `eval`, is simply a stack of values.  The last
-- element is the argument passed to the current function. The previous
-- element is the argument passed to the parent function (when it
-- constructed the current function).  And so on...

local emptyEnv = {}

local function envBind(env, arg)
   local e = clone(env)
   table.insert(e, arg)
   return e
end

local function envArg(env, index)
   return env[#env - index]
end

----------------------------------------------------------------
-- Inner Language
----------------------------------------------------------------

-- Inner Language nodes (IExpr's)
--   (IVal value)           -- constant/literal value
--   (IArg index)           -- argument reference
--   (IFun body)            -- function construction (lambda)
--   (IApp fn arg)          -- function application
--   (INat nfn args)        -- native function call
--   (IBra cond then else)  -- branch (if)
--
-- value : VNode
-- index : (native) number
-- nfn : (native) function
-- all others : IExpr or [IExpr]

local valueType
local faultIf
local valueFmt
local nfnNames = {}

local ilFormatters = {
   IArg = function (e) return "$" .. e[1] end,
   IVal = function (e) return valueFmt(e[1]) end,
   INat = function (e, fmt)
      local nfn, args = e[1], e[2]
      local name = nfnNames[nfn]
      if name == "vvecNth" then
         assert(#args == 2)
         return ("%s[%s]"):format(fmt(args[1]), fmt(args[2]))
      end
      local argValues = concat(imap(args, fmt), " ")
      if name == "vvecNew" then
         return "[" .. argValues .. "]"
      end
      return ("(%s %s)"):format(name, argValues)
   end
}

local function ilFmt(node)
   return recFmt(node, ilFormatters)
end


local function eval(expr, env)
   local typ = expr.type
   local function ee(e)
      return eval(e, env)
   end

   if typ == "IVal" then
      return expr[1]
   elseif typ == "IArg" then
      local index = expr[1]
      local value = assert(envArg(env, index))
      return value
   elseif typ == "IFun" then
      local body = expr[1]
      return rec("VFun", env, body)
   elseif typ == "IApp" then
      local fn, arg = expr[1], expr[2]
      local fnValue = ee(fn)
      faultIf(valueType(fnValue) ~= "VFun", "NotFn", expr.ast, fnValue)
      local fenv, body = unpack(fnValue)
      return eval(body, envBind(fenv, ee(arg)))
   elseif typ == "INat" then
      local nfn, args = expr[1], expr[2]
      return nfn(unpack(imap(args, ee)))
   elseif typ == "IBra" then
      local condExpr, thenExpr, elseExpr = unpack(expr)
      local cond = ee(condExpr)
      -- Some ugliness here: we reach inside a primitve value...
      faultIf(valueType(cond) ~= "boolean", "NotBool", expr.ast, cond)
      return ee(cond and thenExpr or elseExpr)
   else
      test.fail("Unsupported: %Q", expr)
   end
end

----------------------------------------------------------------
-- Built-In Types
----------------------------------------------------------------

-- A Rio built-in Value can be one of:
--
--    VBool = <boolean>           Boolean
--    VNum = <number>             Number
--    VStr = <string>             String
--    (VVec value...)             Vector
--    (VRec {name, value}...)     Record
--    (VFun env params body)      Function
--    (VErr code where what)
--
-- name: string
-- code: string
-- where: ASTNode or nil
-- what: Value
-- all others: Value
--
-- VErr is a pseudo-value: never passed to functions or otherwise used in
-- `eval`, it is passed to `error()`, and then returned from `trapEval`, to
-- indicate that a fault was encountered.

-- Format a value as Rio source text that produces that value (except for
-- functions)
--
function valueFmt(value)
   if type(value) == "string" then
      return string.format("%q", value)
   elseif type(value) ~= "table" then
      return tostring(value)
   end

   if value.type == "VVec" then
      local o = imap(value, valueFmt)
      return "[" .. concat(o, ", ") .. "]"
   elseif value.type == "VRec" then
      local o = {}
      for _, pair in ipairs(value) do
         o[#o+1] = pair[1] .. ": " .. valueFmt(pair[2])
      end
      return "{" .. concat(o, ", ") .. "}"
   elseif value.type == "VFun" then
      local fenv, body = unpack(value)
      return ("(...) => %s"):format(ilFmt(body))
   elseif value.type == "VErr" then
      return "(VErr " .. astFmtV(value) .. ")"
   end
end

function valueType(value)
   local typ = type(value)
   if typ == "table" then
      return value.type
   end
   return typ
end

-- `natives` contains functions that are called via CNat and used
-- directly by `desugar`.
--
local natives = {}

-- A type's "behavior" is a function that obtains properties of its values:
--   (value, propertyName) -> propertyValue
--
local behaviors = {}

function natives.getProp(value, name)
   local gp = behaviors[valueType(value)]
   return gp(value, name)
end

-- faultIf() is called from native functions in the context of an
-- evaluation.
--
function faultIf(cond, typ, where, what)
   if cond then
      error(rec("VErr", typ, where, what))
   end
end

local function baseBehavior(value, name)
   faultIf(true, "UnknownProperty:" .. tostring(name), nil, value)
end

-- Wrap a Lua function operating on two values with a function suitable as a
-- native function for use with makeMethodProp.
--
local function wrapBinop(typeName)
   return function (fn)
      return function(a, args)
         -- The surface language calling convention, used to call the
         -- method, puts its argument in a vector (arg bundle).
         local b = args[1]
         assert(b ~= nil)  -- should not happen
         faultIf(valueType(b) ~= typeName, "Not" .. typeName, nil, b)
         return fn(a, b)
      end
   end
end

-- nativeMethod: (self, args) -> value
-- result: (value) -> VFun that calls `nativeMethod` with `value` and its arg
--
local function makeMethodProp(nativeMethod)
   local body = rec("INat", nativeMethod, {rec("IArg", 1), rec("IArg", 0)})
   return function (value)
      return rec("VFun", envBind(emptyEnv, value), body)
   end
end

-- Construct a behavior from a map of property names to functions that
-- construct properties.
--
local function behaviorFn(propCtors, base)
   base = base or baseBehavior
   return function(value, name)
      local pfn = propCtors[name]
      if pfn then
         return pfn(value)
      end
      return base(value, name)
   end
end

-- Construct the behavior for a type.
--
-- unops: propName -> (self) -> value
-- binops: propName -> (self, b) -> value
-- methods: propName -> (self, args) -> value
--
-- `unops` receive only `self` and return the property value.  A `unop`
--   is equivalent to a `getProperty` function.
--
-- `binops` and `methods` result in the property resolving to a function,
--   and they will be called only when (and if) the property is invoked.
--   Binop functions receive the extracted second argument, after it has
--   been verified to be of the same type as `self`.  Method functions
--   receive the arg bundle directly.
--
local function makeBehavior(unops, binops, methods, typeName, base)
   local nativeMethods = map(binops, wrapBinop(typeName))
   override(nativeMethods, methods)

   -- record names of native functions for debugging
   for name, nativeMethod in pairs(nativeMethods) do
      nfnNames[nativeMethod] = typeName .. name
   end

   local propCtors = map(nativeMethods, makeMethodProp)
   override(propCtors, unops)
   return behaviorFn(propCtors, base)
end

--------------------------------
-- VFun (exclusively constructed by `eval`...)
--------------------------------

function behaviors.VFun(value, name)
   return baseBehavior(value, name)
end

--------------------------------
-- VBool (happens to be Lua boolean)
--------------------------------

local boolUnops = {
   ["Unop_not"] = function (b) return not b end,
}

local boolBinops = {
   ["Op_or"] = function (a, b) return a or b end,
   ["Op_and"] = function (a, b) return a and b end,
   ["Op_=="] = function (a, b) return a == b end,
   ["Op_!="] = function (a, b) return a ~= b end,
}

behaviors.boolean = makeBehavior(boolUnops, boolBinops, {}, "boolean")


--------------------------------
-- VStr  (happens to be Lua string)
--------------------------------

local function newVStr(str)
   return tostring(str)
end

local strUnops = {
   len = function (v) return #v end,
}

-- "Operators" operate on two values of the same type
local strBinops = {
   ["Op_<"] = function (a, b) return a < b end,
   ["Op_=="] = function (a, b) return a == b end,
   ["Op_!="] = function (a, b) return a ~= b end,
   ["Op_<="] = function (a, b) return a <= b end,
   ["Op_<"] = function (a, b) return a < b end,
   ["Op_>="] = function (a, b) return a >= b end,
   ["Op_>"] = function (a, b) return a > b end,
   ["Op_++"] = function (a, b) return a .. b end,
}

local strMethods = {
   slice = function (self, args)
      local start, limit = args[1], args[2]
      faultIf(valueType(start) ~= "number", "NotNumber", nil, start)
      faultIf(valueType(limit) ~= "number", "NotNumber", nil, limit)
      faultIf(start < 0 or start >= #self, "Bounds", nil, start)
      faultIf(limit < start or limit >= #self, "Bounds", nil, start)
      return self:sub(start+1, limit)
   end,

   ["Op_[]"] = function (self, args)
      local offset = args[1]
      faultIf(valueType(offset) ~= "number", "NotNumber", nil, offset)
      faultIf(offset < 0 or offset >= #self, "Bounds", nil, offset)
      return self:byte(offset+1)
   end,
}

behaviors.string = makeBehavior(strUnops, strBinops, strMethods, "string")

--------------------------------
-- VNum (happens to be Lua number)
--------------------------------

local function newVNum(str)
   return tonumber(str)
end

local numUnops = {
   ["Unop_-"] = function (a) return -a end,
}

local numBinops = {
   ["Op_^"] = function (a, b) return a ^ b end,
   ["Op_*"] = function (a, b) return a * b end,
   ["Op_/"] = function (a, b) return a / b end,
   ["Op_//"] = function (a, b) return math.floor(a / b) end,
   ["Op_%"] = function (a, b) return a % b end,
   ["Op_+"] = function (a, b) return a + b end,
   ["Op_-"] = function (a, b) return a - b end,
   ["Op_<"] = function (a, b) return a < b end,
   ["Op_=="] = function (a, b) return a == b end,
   ["Op_!="] = function (a, b) return a ~= b end,
   ["Op_<="] = function (a, b) return a <= b end,
   ["Op_<"] = function (a, b) return a < b end,
   ["Op_>="] = function (a, b) return a >= b end,
   ["Op_>"] = function (a, b) return a > b end,
}

behaviors.number = makeBehavior(numUnops, numBinops, {}, "number")

--------------------------------
-- VVec
--------------------------------

local vecUnops = {
   len = function (v) return #v end,
}

local vecBinops = {
   ["Op_++"] = function (a, b)
      local o = clone(a)
      return move(b, 1, #b, #o+1, o)
   end,
}

local vecMethods = {
   slice = function (self, args)
      local start, limit = args[1], args[2]
      faultIf(valueType(start) ~= "number", "NotNumber", nil, start)
      faultIf(valueType(limit) ~= "number", "NotNumber", nil, limit)
      faultIf(start < 0 or start >= #self, "Bounds", nil, start)
      faultIf(limit < start or limit >= #self, "Bounds", nil, start)
      return rec("VVec", unpack(self, start+1, limit))
   end,

   ["Op_[]"] = function (self, args)
      local offset = args[1]
      faultIf(valueType(offset) ~= "number", "NotNumber", nil, offset)
      faultIf(offset < 0 or offset >= #self, "Bounds", nil, offset)
      return self[offset+1]
   end,
}

behaviors.VVec = makeBehavior(vecUnops, vecBinops, vecMethods, "VVec")

function natives.vvecNew(...)
   return {type="VVec", ...}
end

-- Note different calling convention than vecIndex.  `self` is packed in an
-- arg bundle.
function natives.vvecNth(self, n)
   faultIf(valueType(self) ~= "VVec", "NotVVec", nil, self)
   faultIf(valueType(n) ~= "number", "NotNumber", nil, n)
   faultIf(n < 0 or n >= #self, "Bounds", nil, self)
   return self[n + 1]
end

-- tests
--
local tv1 = natives.vvecNew(newVNum(9), newVNum(8))
test.eq(tv1, rec("VVec", 9, 8))
test.eq(natives.vvecNth(tv1, newVNum(0)), newVNum(9))

--------------------------------
-- VRec
--------------------------------

local vrecEmpty = rec("VRec")

behaviors.VRec = function (value, name)
   for _, pair in ipairs(value) do
      if pair[1] == name then
         return pair[2]
      end
   end
   return baseBehavior(value, name)
end

function natives.vrecNew(names, ...)
   local v = rec("VRec")
   for ii, name in ipairs(names) do
      v[ii] = {name, assert( (select(ii, ...)) )}
   end
   return v
end

test.eq(natives.vrecNew({"a", "b"}, 3, 5),
        rec("VRec", {"a", 3}, {"b", 5}))


--------------------------------
-- Store names of native functions for debugging
--------------------------------

for name, fn in pairs(natives) do
   nfnNames[fn] = name
end

----------------------------------------------------------------
-- De-sugar Surface Language to Inner Language
----------------------------------------------------------------

local function nameToString(ast)
   assert(ast.type == "Name")
   return ast[1]
end

local function nameToVStr(name)
   test.eq(name.type, "Name")
   return newVStr(name[1])
end

local emptyScope = {
   depth = 0
}

local function scopeExtend(scope, params)
   local s = clone(scope)
   local depth = scope.depth + 1
   s.depth = depth
   for ii, name in ipairs(params) do
      s[nameToString(name)] = {depth = depth, offset = ii-1}
   end
   return s
end

local function scopeFind(scope, name)
   local defn = scope[name]
   if defn then
      return scope.depth - defn.depth, defn.offset
   end
end

local function desugar(ast, scope)
   local function ds(a)
      return desugar(a, scope)
   end

   local function C(typ, ...)
      return {type=typ, ast=ast, ...}
   end

   local function IVal(value)
      -- promote Lua bool/num/string to Value, if necessary
      return C("IVal", value)
   end

   local function nat(name, args)
      return C("INat", assert(natives[name]), args)
   end

   local function lambda(params, body)
      return C("IFun", desugar(body, scopeExtend(scope, params)))
   end

   local function apply(fnIL, argsAST)
      return C("IApp", fnIL, nat("vvecNew", imap(argsAST, ds)))
   end

   local function gp(valueAST, nameV)
      return nat("getProp", {ds(valueAST), IVal(nameV)})
   end

   local typ = ast.type

   if typ == "Name" then
      local index, offset = scopeFind(scope, nameToString(ast))
      faultIf(index == nil, "Undefined", ast, nil)
      return nat("vvecNth", {C("IArg", index), IVal(newVNum(offset))})
   elseif typ == "Number" then
      return IVal(newVNum(ast[1]))
   elseif typ == "String" then
      return IVal(newVStr(ast[1]))
   elseif typ == "Fn" then
      local params, body = ast[1], ast[2]
      return lambda(params, body)
   elseif typ == "Op_()" then
      local fn, args = ast[1], ast[2]
      return apply(ds(fn), args)
   elseif typ == "Op_." then
      local value, name = ast[1], ast[2]
      return gp(value, nameToVStr(name))
   elseif typ == "If" then
      return C("IBra", ds(ast[1][1]), ds(ast[1][2]), ds(ast[2]))
   elseif typ == "Let" and ast[1][2] == "=" then
      local name, value, body = ast[1][1], ast[1][3], ast[2]
      return apply(lambda({name}, body), {value})
   elseif typ == "Ignore" then
      return ds(ast[2])
   elseif typ == "Vector" then
      local elems = ast[1]
      return nat("vvecNew", imap(elems, ds))
   elseif typ == "Record" then
      local rpairs = ast[1]
      local keys = {}
      local values = {}
      for ii = 1, #rpairs, 2 do
         keys[#keys+1] = IVal(nameToVStr(rpairs[ii]))
         values[#values+1] = ds(rpairs[ii+1])
      end
      return nat("vrecNew", {nat("vvecNew", keys), unpack(values)})
   elseif typ == "IIf" then
      return C("IBra", ds(ast[1]), ds(ast[2]), ds(ast[3]))
   elseif typ:match("^Op_") then
      local a, b = ast[1], ast[2]
      return apply(gp(a, typ), {b})
   elseif typ:match("^Unop_") then
      local a = ast[1]
      return gp(a, typ)
   else
      test.fail("Unsupported: %s", astFmt(ast))
   end
end

----------------------------------------------------------------
-- Tests
----------------------------------------------------------------

local function evalAST(ast)
   return eval(desugar(ast, emptyScope), emptyEnv)
end

local function trapEval(fn, ...)
   local succ, value = xpcall(fn, debug.traceback, ...)
   if not succ and type(value) == "string" then
      print(value)
      error(value, 0)
   end
   return value
end

local function et(source, evalue, eoob)
   local ast, oob = syntax.parseModule(source)
   test.eqAt(2, eoob or "", astFmtV(oob or {}))
   test.eqAt(2, evalue, valueFmt(trapEval(evalAST, ast)))
end

-- parse error

et(".5", "0.5", "(Error 'NumDigitBefore')")

-- eval error

et("x", "(VErr 'Undefined' x)")

-- literals and constructors

et("1.23", "1.23")
et([["abc"]], [["abc"]])
et("[1,2,3]", "[1, 2, 3]")
et("{a: 1, b: 2}", "{a: 1, b: 2}")

-- operators and properties ...

-- ... Boolean

et("not (1==1)", "false")
et("1==1 or 1==2", "true")
et("1==1 and 1==2", "false")
et("(1==1) != (1==2)", "true")

-- ... Number
et("1 + 2", "3")
et("7 // 3", "2")
et("-(1)", "-1")
et("1 < 2", "true")
et("1 < 2 < 3", "true")

-- ... String
et([[ "abc" ++ "def" ]], [["abcdef"]])
et([[ "abc".len ]], "3")
et([[ "abcd".slice(1, 3) ]], [["bc"]])
et([[ "abc" == "abc" ]], "true")
et([[ "abc"[1] ]], "98")

-- ... Vector

et("[7,8,9].len", "3")
et("[7,8,9,0].slice(1,3)", "[8, 9]")
et("[7,8,9,0].slice(1,1)", "[]")
et("[7,8,9][1]", "8")

-- ... Record

et("{a:1}.a", "1")

-- Fn

et("x => x", "(...) => $0[0]")

-- Op_()

et("(x => 1)(2)", "1")
et("(x => x+1)(2)", "3")

-- If

et("if 1 < 2: 1\n0\n", "1")
et("if 1 < 0: 1\n0\n", "0")

-- Let

et("x = 1\nx + 2\n", "3")

local fib = [[
_fib = (_fib, n) =>
    fib = n => _fib(_fib, n)
    if n <= 1: 0
    if n == 2: 1
    fib(n - 1) + fib(n - 2)

fib = n => _fib(_fib, n)

fib(8)
]]

et(fib, "13")
