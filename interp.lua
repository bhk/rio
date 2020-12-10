-- Rio interpreter

local test = require "test"
local syntax = require "syntax"
local persist = require "persist"
local reclib = require "rec"

local imap, clone, move = persist.imap, persist.clone, persist.move
local astFmt, astFmtV = syntax.astFmt, syntax.astFmtV
local concat, unpack = table.concat, table.unpack
local rec, recFmt = reclib.rec, reclib.recFmt


local function nameString(node)
   assert(node.type == "Name")
   return node[1]
end


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
--    (VNat name)                 Native function
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
   opFuncs[op] = rec("VNat", op)
end


-- VVec methods

local vvecEmpty = rec("VVec")


function natives.vvecCons(vec, item)
   faultIf(valueType(vec) ~= "VVec", "NotVVec", nil, vec)
   local o = rec("VVec", item)
   move(vec, 1, #vec, 2, o)
   return o
end


-- A function value: construct a new vector by prepending an item
local vvecCons = rec("VNat", "vvecCons")


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

-- A function value: construct a new record by adding a pair definition
local vrecSet = rec("VNat", "vrecSet")


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
      local env, params, body = unpack(value)
      return ("(%s) => %s"):format(concat(params, " "), clFmt(body))
   elseif value.type == "VNat" then
      return "$" .. value[1]
   elseif value.type == "VErr" then
      return "(VErr " .. astFmtV(value) .. ")"
   end
end


----------------------------------------------------------------
-- Environments
----------------------------------------------------------------

local function bind(env, params, args)
   local o = clone(env)
   for ii, param in ipairs(params) do
      o[param] = args[ii]
   end
   return o
end


----------------------------------------------------------------
-- Construct CL from AST
----------------------------------------------------------------

-- Core Language nodes (CNodes):
--   (CVal value)           -- constants (literals, PE results)
--   (CArg name)            -- argument reference
--   (CFun names body)      -- function construction (lambda)
--   (CApp fn args)         -- function application
--   (CBra cond then else)  -- branch (if)
--
-- value : VNode
-- name : string
-- names : [string]
-- all others : CNode or [CNode]


local function nameToVStr(name)
   test.eq(name.type, "Name")
   return newVStr(name[1])
end


local function CVal(value)
   return rec("CVal", value)
end


local function CApp(fn, args)
   return rec("CApp", fn, args)
end


local clFormatters = {
   CArg = function (v) return v[1] end,
   CVal = function (v) return valueFmt(v[1]) end,
}


function clFmt(node)
   return recFmt(node, clFormatters)
end


local function clFrom(ast)
   local typ = ast.type

   local function rec(typ, ...)
      return {type=typ, ast=ast, ...}
   end

   if typ == "Name" then
      return rec("CArg", ast[1])
   elseif typ == "Number" then
      return CVal(newNumber(ast[1]))
   elseif typ == "String" then
      return CVal(newVStr(ast[1]))
   elseif typ == "Fn" then
      local params = imap(ast[1], nameString)
      return rec("CFun", params, clFrom(ast[2]))
   elseif typ == "Op_()" then
      return CApp(clFrom(ast[1]), imap(ast[2], clFrom))
   elseif typ == "If" then
      return rec("CBra", clFrom(ast[1][1]), clFrom(ast[1][2]), clFrom(ast[2]))
   elseif typ == "Let" and ast[1][2] == "=" then
      local name = nameString(ast[1][1])
      local value = clFrom(ast[1][3])
      local body = clFrom(ast[2])
      local fn = rec("CFun", {name}, body)
      return CApp(fn, {value})
   elseif typ == "Ignore" then
      return clFrom(ast[2])
   elseif typ == "Vector" then
      local elems = ast[1]
      local vec = CVal(vvecEmpty)
      for ii = #elems, 1, -1 do
         vec = CApp(CVal(vvecCons), {vec, clFrom(elems[ii])})
      end
      return vec
   elseif typ == "Record" then
      local rpairs = ast[1]
      local o = CVal(vrecEmpty)
      for ii = 1, #rpairs, 2 do
         local clName = CVal(nameToVStr(rpairs[ii]))
         local clValue = clFrom(rpairs[ii+1])
         o = CApp(CVal(vrecSet), {o, clName, clValue})
      end
      return o
   elseif typ == "IIf" then
      return rec("CBra", clFrom(ast[1]), clFrom(ast[2]), clFrom(ast[3]))
   elseif opFuncs[typ] then
      -- hacky shortcut: use `op` as native function name (TODO: dispatch)
      local a, b = clFrom(ast[1]), clFrom(ast[2])
      return CApp(CVal(opFuncs[typ]), {a, b})
   else
      -- Op_., Op_[], Op_X, Unop_X, Missing, For, Loop, LoopWhile, While, Act
      test.fail("Unsupported: %s", astFmt(ast))
   end
end


----------------------------------------------------------------
-- Evaluation
----------------------------------------------------------------

local function clEval(node, env)
   local typ = node.type
   local function eval(n)
      return clEval(n, env)
   end

   if typ == "CVal" then
      return node[1]
   elseif typ == "CArg" then
      local value = env[node[1]]
      faultIf(value == nil, "Undefined", node.ast, nil)
      return value
   elseif typ == "CFun" then
      return rec("VFun", env, node[1], node[2])
   elseif typ == "CApp" then
      local fn, args = eval(node[1]), imap(node[2], eval)
      local fnType = valueType(fn)
      if fnType == "VNat" then
         return natives[fn[1]](unpack(args))
      elseif fnType == "VFun" then
         local fenv, params, body = unpack(fn)
         faultIf(#args ~= #params, "ArgCount", node.ast, fn)
         return clEval(body, bind(fenv, params, args))
      end
      faultIf(true, "NotFn", node.ast, fn)
   elseif typ == "CBra" then
      local clCond, clThen, clElse = unpack(node)
      local cond = eval(clCond)
      faultIf(valueType(cond) ~= "boolean", "NotBool", node.ast, cond)
      return eval(cond and clThen or clElse)
   else
      test.fail("Unsupported: %Q", node)
   end
end


local function astEval(ast, env)
   return clEval(clFrom(ast), env)
end

----------------------------------------------------------------
-- Tests
----------------------------------------------------------------


local initialEnv = {
}


local function trapEval(fn, ...)
   local succ, value = xpcall(fn, debug.traceback, ...)
   if not succ and type(value) == "string" then
      error(value, 0)
   end
   return value
end


local function traceWrap(eval)
   local function traceEval(node, env)
      local o = astEval(node, env)
      print(string.format("%5d %s", node.pos, valueFmt(o)))
      return o
   end
   return traceEval
end


local function et(source, evalue, eoob)
   local node, oob = syntax.parseModule(source)
   test.eqAt(2, eoob or "", astFmtV(oob or {}))
   test.eqAt(2, evalue, valueFmt(trapEval(astEval, node, initialEnv)))
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

et("x => x", "(x) => x")

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
