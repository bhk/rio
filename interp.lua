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
-- Primitive Types
----------------------------------------------------------------

-- A "VNode" holds a Rio primitive value.  It can be one of:
--
--    <boolean>
--    <number>
--    <string>
--    (VVec value...)             Vector
--    (VRec {name, value}...)     Record
--    (VFun env params body)      CL-based function
--    (VErr code where what)      (pseudo-value holding error results)
--
-- name: string
-- code: string
-- where: ASTNode or nil
-- what: VNode
-- all others: VNode
--

local function valueType(node)
   local typ = type(node)
   if typ == "table" then
      return node.type
   end
   return typ
end


local function newVStr(str)
   return str
end


local natives = {}

local opFuncs = {}


-- faultIf() is called from native functions in the context of an
-- evaluation.
--
local function faultIf(cond, typ, where, what)
   if cond then
      error(rec("VErr", typ, where, what))
   end
end


-- Number methods

local function newNumber(str)
   return tonumber(str)
end


local numOps = {
   ["Op_-"] = function (a, b) return a - b end,
   ["Op_+"] = function (a, b) return a + b end,
   ["Op_<"] = function (a, b) return a < b end,
   ["Op_<="] = function (a, b) return a <= b end,
   ["Op_>="] = function (a, b) return a >= b end,
   ["Op_=="] = function (a, b) return a == b end,
}


for op, fn in pairs(numOps) do
   local function nat(a, b)
      faultIf(type(a) ~= "number", "NotNumberL", nil, a)
      faultIf(type(b) ~= "number", "NotNumberR", nil, b)
      return fn(a, b)
   end
   natives[op] = nat
   opFuncs[op] = op
end


-- VVec methods

local vvecEmpty = rec("VVec")


function natives.vvecCons(vec, item)
   faultIf(valueType(vec) ~= "VVec", "NotVVec", nil, vec)
   local o = rec("VVec", item)
   move(vec, 1, #vec, 2, o)
   return o
end


function natives.vvecNth(vec, n)
   faultIf(valueType(vec) ~= "VVec", "NotVVec", nil, vec)
   faultIf(valueType(n) ~= "number", "NotNumber", nil, n)
   local value = vec[n + 1]
   faultIf(value == nil, "VVecBounds", nil, vec)
   return value
end


function natives.vvecNew(...)
   return {type="VVec", ...}
end


local tv1 = natives.vvecNew(newNumber(9), newNumber(8))
test.eq(tv1, rec("VVec", 9, 8))
test.eq(natives.vvecNth(tv1, newNumber(0)), newNumber(9))


-- Construct expression for `r.push(item)`
--
local function cl_VVecCons(v, item)
   return rec("CNat", "vvecCons", {v, item})
end

local function cl_VVecNth(v, n)
   return rec("CNat", "vvecNth", {v, n})
end


-- VRec methods

local vrecEmpty = rec("VRec")

function natives.vrecSet(rec, name, value)
   faultIf(rec.type ~= "VRec", "NotVRec", nil, rec)
   local o = clone(rec)
   for ii, pair in ipairs(o) do
      if pair[1] == name then
         o[ii] = {name, value}
         return o
      end
   end
   o[#o+1] = {name, value}
   return o
end


-- We treat this as a VRec-specific native function, but ultimately this is
-- a much more generic operation, and VRec will be just one subscriber to
-- its protocol.  For now, we just look up a VRec member.
--
function natives.getProp(v, name)
   faultIf(type(name) ~= "string", "NotVRec", nil, name)
   faultIf(valueType(v) ~= "VRec", "NotVRec", nil, v)
   for _, pair in ipairs(v) do
      if pair[1] == name then
         return pair[2]
      end
   end
   faultIf(true, "NoSuchProp", nil, name)
end

-- Construct expression for `r[name] <! value`
--
-- Note: r, name, value, and result are all CL nodes.
--
local function cl_VRecSet(r, name, value)
   return rec("CNat", "vrecSet", {r, name, value})
end



local clFmt


-- Format a value as Rio source text
--
local function valueFmt(value)
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


----------------------------------------------------------------
-- Environments
----------------------------------------------------------------

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
-- Construct CL from AST
----------------------------------------------------------------

-- Core Language nodes (CExprs):
--   (CVal value)           -- constants (literals, PE results)
--   (CArg index)           -- argument reference
--   (CFun body)            -- function construction (lambda)
--   (CApp fn arg)          -- function application
--   (CNat name args)       -- native function call
--   (CBra cond then else)  -- branch (if)
--
-- value : VNode
-- name : string
-- names : [string]
-- all others : CExpr or [CExpr]


local function nameToString(ast)
   assert(ast.type == "Name")
   return ast[1]
end

local function nameToVStr(name)
   test.eq(name.type, "Name")
   return newVStr(name[1])
end


local clFormatters = {
   CArg = function (e) return "$" .. e[1] end,
   CVal = function (e) return valueFmt(e[1]) end,
   CNat = function (e, fmt)
      local name, args = e[1], e[2]
      if name == "vvecNth" then
         assert(#args == 2)
         return ("%s[%s]"):format(fmt(args[1]), fmt(args[2]))
      end
      return ("(%s %s)"):format(name, concat(imap(args, fmt), " "))
   end
}


function clFmt(node)
   return recFmt(node, clFormatters)
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

   local function lambda(params, body)
      return C("CFun", desugar(body, scopeExtend(scope, params)))
   end

   local function call(cl_fn, ast_args)
      return C("CApp", cl_fn, C("CNat", "vvecNew", imap(ast_args, ds)))
   end

   local function CVal(value)
      return C("CVal", value)
   end

   local function CNat(name, args)
      return C("CNat", name, args)
   end


   local typ = ast.type

   if typ == "Name" then
      local index, offset = scopeFind(scope, nameToString(ast))
      faultIf(index == nil, "Undefined", ast, nil)
      return cl_VVecNth(C("CArg", index), CVal(newNumber(offset)))
   elseif typ == "Number" then
      return CVal(newNumber(ast[1]))
   elseif typ == "String" then
      return CVal(newVStr(ast[1]))
   elseif typ == "Fn" then
      local params, body = ast[1], ast[2]
      return lambda(params, body)
   elseif typ == "Op_()" then
      local fn, args = ast[1], ast[2]
      return call(ds(fn), args)
   elseif typ == "Op_[]" then
      local v, key = ast[1], ast[2]
      return C("CNat", "vvecNth", {ds(v), ds(key)})
   elseif typ == "Op_." then
      local value, name = ast[1], ast[2]
      return C("CNat", "getProp", {ds(value), CVal(nameToVStr(name))})
   elseif typ == "If" then
      return C("CBra", ds(ast[1][1]), ds(ast[1][2]), ds(ast[2]))
   elseif typ == "Let" and ast[1][2] == "=" then
      local name, value, body = ast[1][1], ast[1][3], ast[2]
      return call(lambda({name}, body), {value})
   elseif typ == "Ignore" then
      return ds(ast[2])
   elseif typ == "Vector" then
      local elems = ast[1]
      local vec = CVal(vvecEmpty)
      for ii = #elems, 1, -1 do
         vec = cl_VVecCons(vec, ds(elems[ii]))
      end
      return vec
   elseif typ == "Record" then
      local rpairs = ast[1]
      local o = CVal(vrecEmpty)
      for ii = 1, #rpairs, 2 do
         local nameExpr = CVal(nameToVStr(rpairs[ii]))
         local valueExpr = ds(rpairs[ii+1])
         o = cl_VRecSet(o, nameExpr, valueExpr)
      end
      return o
   elseif typ == "IIf" then
      return C("CBra", ds(ast[1]), ds(ast[2]), ds(ast[3]))
   elseif opFuncs[typ] then
      -- hacky shortcut: use `op` as native function name (TODO: dispatch)
      local a, b = ast[1], ast[2]
      return CNat(typ, {ds(a), ds(b)})
   else
      test.fail("Unsupported: %s", astFmt(ast))
   end
end


----------------------------------------------------------------
-- Evaluation
----------------------------------------------------------------

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
      local name, args = expr[1], expr[2]
      return natives[name](unpack(imap(args, ee)))
   elseif typ == "CBra" then
      local condExpr, thenExpr, elseExpr = unpack(expr)
      local cond = ee(condExpr)
      faultIf(valueType(cond) ~= "boolean", "NotBool", expr.ast, cond)
      return ee(cond and thenExpr or elseExpr)
   else
      test.fail("Unsupported: %Q", expr)
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


-- local function traceWrap(eval)
--    local function traceEval(node, env)
--       local o = evalAST(node, env)
--       print(string.format("%5d %s", node.pos, valueFmt(o)))
--       return o
--    end
--    return traceEval
-- end


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
