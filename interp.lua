-- Rio interpreter

local test = require "test"
local syntax = require "syntax"
local persist = require "persist"
local reclib = require "rec"

local imap, clone, move = persist.imap, persist.clone, persist.move
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
-- Core Language
----------------------------------------------------------------

-- Core Language nodes (CExprs):
--   (CVal value)           -- constant/literal value
--   (CArg index)           -- argument reference
--   (CFun body)            -- function construction (lambda)
--   (CApp fn arg)          -- function application
--   (CNat nfn args)        -- native function call
--   (CBra cond then else)  -- branch (if)
--
-- value : VNode
-- index : (native) number
-- nfn : (native) function
-- all others : CExpr or [CExpr]

local valueType
local faultIf

local function eval(expr, env)
   local typ = expr.type
   local function ee(e)
      return eval(e, env)
   end

   if typ == "CVal" then
      return expr[1]
   elseif typ == "CArg" then
      local index = expr[1]
      local value = assert(envArg(env, index))
      return value
   elseif typ == "CFun" then
      local body = expr[1]
      return rec("VFun", env, body)
   elseif typ == "CApp" then
      local fn, arg = expr[1], expr[2]
      local fnValue = ee(fn)
      faultIf(valueType(fnValue) ~= "VFun", "NotFn", expr.ast, fnValue)
      local fenv, body = unpack(fnValue)
      return eval(body, envBind(fenv, ee(arg)))
   elseif typ == "CNat" then
      local nfn, args = expr[1], expr[2]
      return nfn(unpack(imap(args, ee)))
   elseif typ == "CBra" then
      local condExpr, thenExpr, elseExpr = unpack(expr)
      local cond = ee(condExpr)
      -- Some ugliness here: we reach inside a primitve value...
      faultIf(valueType(cond) ~= "boolean", "NotBool", expr.ast, cond)
      return ee(cond and thenExpr or elseExpr)
   else
      test.fail("Unsupported: %Q", expr)
   end
end

local valueFmt
local nfnNames = {}

local clFormatters = {
   CArg = function (e) return "$" .. e[1] end,
   CVal = function (e) return valueFmt(e[1]) end,
   CNat = function (e, fmt)
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

local function clFmt(node)
   return recFmt(node, clFormatters)
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
   if type(value) ~= "table" then
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
      return ("(...) => %s"):format(clFmt(body))
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

-- behaviors are actually `getProperty` functions.
local behaviors = {}

local function getBehavior(value)
   return behaviors[valueType(value)]
end

local natives = {}

function natives.getProp(value, name)
   local gp = getBehavior(value)
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

--------------------------------
-- VFun (exclusively constructed by `eval`...)
--------------------------------

function behaviors.VFun(value, name)
   return baseBehavior(value, name)
end

--------------------------------
-- VBool (happens to be Lua boolean)
--------------------------------

function behaviors.boolean(value, name)
   return baseBehavior(value, name)
end

--------------------------------
-- VStr  (happens to be Lua string)
--------------------------------

local function newVStr(str)
   return tostring(str)
end

function behaviors.string(value, name)
   return baseBehavior(value, name)
end

--------------------------------
-- VNum (happens to be Lua number)
--------------------------------

local function newVNum(str)
   return tonumber(str)
end

local numBinary = {
   ["Op_^"] = function (a, b) return a ^ b end,
   ["Op_*"] = function (a, b) return a * b end,
   ["Op_/"] = function (a, b) return a / b end,
   ["Op_//"] = function (a, b) return math.floor(a / b) end,
   ["Op_%"] = function (a, b) return a % b end,
   ["Op_+"] = function (a, b) return a + b end,
   ["Op_-"] = function (a, b) return a - b end,
   ["Op_<"] = function (a, b) return a < b end,
   ["Op_=="] = function (a, b) return a == b end,
   ["Op_!="] = function (a, b) return a != b end,
   ["Op_<="] = function (a, b) return a <= b end,
   ["Op_<"] = function (a, b) return a < b end,
   ["Op_>="] = function (a, b) return a >= b end,
   ["Op_>"] = function (a, b) return a > b end,
}

-- create native functions and method bodies for numeric ops
local numMethods = {}
for op, fn in pairs(numBinary) do
   local function nfn(a, bArgs)
      faultIf(type(a) ~= "number", "NotNumberL", nil, a)
      local b = assert(bArgs[1])
      faultIf(type(b) ~= "number", "NotNumberR", nil, b)
      return fn(a, b)
   end
   natives["vnum:" .. op] = nfn
   numMethods[op] = rec("CNat", nfn, {rec("CArg", 1), rec("CArg", 0)})
end


function behaviors.number(value, name)
   if name == "Unop_-" then
      return -value
   end
   local body = numMethods[name]
   if body then
      return rec("VFun", envBind(emptyEnv, value), body)
   end
   return baseBehavior(value, name)
end


--------------------------------
-- VVec
--------------------------------

local vvecEmpty = rec("VVec")

function behaviors.VVec(value, name)
   return baseBehavior(value, name)
end

function natives.vvecNew(...)
   return {type="VVec", ...}
end

function natives.vvecNth(vec, n)
   faultIf(valueType(vec) ~= "VVec", "NotVVec", nil, vec)
   faultIf(valueType(n) ~= "number", "NotNumber", nil, n)
   local value = vec[n + 1]
   faultIf(value == nil, "VVecBounds", nil, vec)
   return value
end

local tv1 = natives.vvecNew(newVNum(9), newVNum(8))
test.eq(tv1, rec("VVec", 9, 8))
test.eq(natives.vvecNth(tv1, newVNum(0)), newVNum(9))

--------------------------------
-- VRec
--------------------------------

local vrecEmpty = rec("VRec")

function behaviors.VRec(value, name)
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


for name, fn in pairs(natives) do
   nfnNames[fn] = name
end

----------------------------------------------------------------
-- De-sugar Surface Language to Core
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

   local function CVal(value)
      -- promote Lua bool/num/string to Value, if necessary
      return C("CVal", value)
   end

   local function nat(name, args)
      return C("CNat", assert(natives[name]), args)
   end

   local function lambda(params, body)
      return C("CFun", desugar(body, scopeExtend(scope, params)))
   end

   local function apply(fnCL, argsAST)
      return C("CApp", fnCL, nat("vvecNew", imap(argsAST, ds)))
   end

   local function gp(valueAST, nameV)
      return nat("getProp", {ds(valueAST), CVal(nameV)})
   end

   local typ = ast.type

   if typ == "Name" then
      local index, offset = scopeFind(scope, nameToString(ast))
      faultIf(index == nil, "Undefined", ast, nil)
      return nat("vvecNth", {C("CArg", index), CVal(newVNum(offset))})
   elseif typ == "Number" then
      return CVal(newVNum(ast[1]))
   elseif typ == "String" then
      return CVal(newVStr(ast[1]))
   elseif typ == "Fn" then
      local params, body = ast[1], ast[2]
      return lambda(params, body)
   elseif typ == "Op_()" then
      local fn, args = ast[1], ast[2]
      return apply(ds(fn), args)
   elseif typ == "Op_[]" then
      local v, key = ast[1], ast[2]
      return nat("vvecNth", {ds(v), ds(key)})
   elseif typ == "Op_." then
      local value, name = ast[1], ast[2]
      return gp(value, nameToVStr(name))
   elseif typ == "If" then
      return C("CBra", ds(ast[1][1]), ds(ast[1][2]), ds(ast[2]))
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
         keys[#keys+1] = CVal(nameToVStr(rpairs[ii]))
         values[#values+1] = ds(rpairs[ii+1])
      end
      return nat("vrecNew", {nat("vvecNew", keys), unpack(values)})
   elseif typ == "IIf" then
      return C("CBra", ds(ast[1]), ds(ast[2]), ds(ast[3]))
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
et([["abc"]], "abc")
et("[1,2,3]", "[1, 2, 3]")
et("{a: 1, b: 2}", "{a: 1, b: 2}")

-- operators

et("1 + 2", "3")
et("1 < 2", "true")
et("-(1)", "-1")

-- Fn

et("x => x", "(...) => $0[0]")

-- Op_()

et("(x => 1)(2)", "1")
et("(x => x+1)(2)", "3")

-- Op_.

et("{a:1}.a", "1")

-- Op_[]

et("[9,8,7][1]", "8")

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
