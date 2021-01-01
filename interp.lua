-- Rio interpreter

local test = require "test"
local misc = require "misc"
local syntax = require "syntax"

local append, clone, ifilter, imap, map, move, override, sexprFormatter =
   misc.append, misc.clone, misc.ifilter, misc.imap, misc.map,
   misc.move, misc.override, misc.sexprFormatter
local astFmt, astFmtV = syntax.astFmt, syntax.astFmtV
local concat, unpack = table.concat, table.unpack

----------------------------------------------------------------
-- desugar: Surface Language to Middle Language
----------------------------------------------------------------
--
-- This translation requires no knowledge of the enclosing scope.  Instead
-- of translating an AST tree to an ML tree, we could construct the ML tree
-- directly during parsing.  That would be more performant and simplify this
-- code slightly, but it would complicate initialization/construction of the
-- parser.
--
-- The middle language retains surface language semantics but uses a reduced
-- set of primitives.  Functions accept argument bundles, and values have
-- properties.
--
--     (MVal nativevalue)
--     (MName name)
--     (MFun params mexpr sOK)
--     (MCall fn args)
--     (MProp value name)
--     (MLoop body k)
--     (MError desc ast)
--
-- params: {string...}
-- name: string
-- nativevalue: string | number
--
-- There is no notion of "native" functions in ML, but constructed
-- expressions reference the following free variables:
--     .vecNew : values -> vector
--     .recDef : names -> values -> record

local mlFmt = sexprFormatter {
   MName = function (v) return v[1] end,
}

local function snameToString(ast)
   assert(ast.T == "Name")
   return ast[1]
end

local function mval(val)
   return {T="MVal", val}
end

local function mname(str)
   return {T="MName", str}
end

local function mlambda(params, body, shadowMode)
   return {T="MFun", params, body, shadowMode}
end

local function mcall(mfn, margs)
   return {T="MCall", mfn, margs}
end

local function mprop(mvalue, name)
   return {T="MProp", mvalue, name}
end

local function mlet(name, value, expr, shadowMode)
   return mcall(mlambda({name}, expr, shadowMode), {value})
end

local function msend(value, name, args)
   return mcall(mprop(value, name), args)
end

local function mbranch(mcond, mthen, melse)
   return mcall(msend(mcond, "switch", {mlambda({}, mthen), mlambda({}, melse)}),
               {})
end

local function mbinop(op, a, b)
   return mcall(mprop(a, "{}"..op), {b})
end

local desugarBlock

-- Translate AST expression into Middle Language
--
local function desugarExpr(ast)
   local ds = desugarExpr
   local typ = ast.T

   if typ == "Name" then
      return mname(ast[1])
   elseif typ == "Number" then
      return mval(tonumber(ast[1]))
   elseif typ == "String" then
      return mval(ast[1])
   elseif typ == "Fn" then
      local params, body = ast[1], ast[2]
      return mlambda(imap(params, snameToString), ds(body))
   elseif typ =="Call" then
      local fn, args = ast[1], ast[2]
      return mcall(ds(fn), imap(args, ds))
   elseif typ =="Dot" then
      local a, b = ast[1], ast[2]
      return mprop(ds(a), snameToString(b))
   elseif typ =="Index" then
      local a, b = ast[1], ast[2]
      return mbinop("[]", ds(a), ds(b))
   elseif typ =="Binop" then
      local op, a, b = ast[1], ast[2], ast[3]
      if op == "$" then
         return mcall(ds(a), {ds(b)})
      end
      return mbinop(op, ds(a), ds(b))
   elseif typ == "Unop" then
      local op, svalue = ast[1], ast[2]
      return mprop(ds(svalue), op)
   elseif typ == "IIf" then
      local c, a, b = ast[1], ast[2], ast[3]
      return branch(ds(c), ds(a), ds(b))
   elseif typ == "Vector" then
      local elems = ast[1]
      return mcall(mname".vecNew", imap(elems, ds))
   elseif typ == "Record" then
      local rpairs = ast[1]
      local keys = {}
      local values = {}
      for ii = 1, #rpairs, 2 do
         keys[#keys+1] = mval(snameToString(rpairs[ii]))
         values[#values+1] = ds(rpairs[ii+1])
      end
      local recCons = mcall(mname ".recDef", keys)
      return mcall(recCons, values)
   elseif typ == "Block" then
      local lines = ast[1]
      return desugarBlock(lines)
   elseif typ == "Missing" then
      return {T="MError", "MissingExpr", ast}
   else
      test.fail("Unknown AST: %s", astFmt(ast))
   end
end

local function peelTarget(ast, mvalue)
   local ds = desugarExpr
   if ast.T == "Name" then
      return ast, mvalue
   elseif ast.T == "Index" then
      local tgt, idx = ast[1], ast[2]
      return peelTarget(tgt, msend(ds(tgt), "set", {ds(idx), mvalue}))
   elseif ast.T == "Dot" then
      local tgt, sname = ast[1], ast[2]
      local mname = mval(snameToString(sname))
      return peelTarget(tgt, msend(ds(tgt), "setProp", {mname, mvalue}))
   end
end

local function desugarStmt(ast, k)
   local typ = ast.T
   if typ == "S-If" then
      local scond, sthen = ast[1], ast[2]
      return mbranch(desugarExpr(scond), desugarExpr(sthen), k)
   elseif typ == "S-Let" then
      -- operators:  =  :=  +=  *= ...
      local sname, op, svalue = ast[1], ast[2], ast[3]
      local sname, mvalue = peelTarget(sname, desugarExpr(svalue))
      local name = snameToString(sname)
      -- handle +=, etc.
      local modop = op:match("^([^:=]+)")
      if modop then
         mvalue = mbinop(modop, desugarExpr(sname), mvalue)
      end
      local shadowMode = op == "=" and "=" or ":="
      return mcall(mlambda({name}, k, shadowMode), {mvalue})
   elseif typ == "S-Loop" then
      local block = ast[1]
      local rep = {T="Name", pos=ast.pos, "repeat"}
      return {T="MLoop", desugarBlock(append(block, {rep})), k}
   elseif typ == "S-While" then
      local cond = ast[1]
      return mbranch(desugarExpr(cond), k, mname"break")
   elseif typ == "S-LoopWhile" then
      local cond, block = ast[1], ast[2]
      return desugarStmt({T="S-Loop", append({{T="S-While", cond}}, block)}, k)
   else
      test.fail("Unknown statement: %s", astFmt(ast))
   end
end

-- Translate AST block into Middle Language, starting at index `ii`
--
function desugarBlock(lines, ii)
   ii = ii or 1
   local k = lines[ii+1] and desugarBlock(lines, ii+1)
   local line = lines[ii]

   if string.match(line.T, "^S%-") then
      return desugarStmt(line, k or {T="MError", "MissingFinalExpr", line})
   elseif k then
      -- silently ignore extraneous expression
      return {T="MError", "Extraneous", line}
   end
   return desugarExpr(line)
end

----------------------------------------------------------------
-- Environments
----------------------------------------------------------------

-- An environment, as used in `eval`, is simply a stack of values.  The last
-- element is the argument passed to the current function. The previous
-- element is the argument passed to the parent function (when it
-- constructed the current function).  And so on...

local emptyEnv = {}

local function envBind(env, arg)
   local e = {[1] = arg}
   return move(env, 1, #env, 2, e)
end

local function envArg(env, index)
   return env[index+1]
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
--
-- value : VNode
-- index : (native) number
-- nfn : (native) function
-- all others : IExpr or [IExpr]

local valueType
local faultIf
local valueFmt
local nfnNames = {}

local ilFmt = sexprFormatter {
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
         return "@[" .. argValues .. "]"
      end
      return ("(%s %s)"):format(name, argValues)
   end
}

local function eval(expr, env)
   local typ = expr.T
   local function ee(e)
      return eval(e, env)
   end

   if typ == "IVal" then
      return expr[1]
   elseif typ == "IArg" then
      local index = expr[1]
      local value = envArg(env, index)
      assert(value ~= nil)
      return value
   elseif typ == "IFun" then
      local body = expr[1]
      return {T="VFun", env, body}
   elseif typ == "IApp" then
      local fn, arg = expr[1], expr[2]
      local fnValue = ee(fn)
      faultIf(valueType(fnValue) ~= "VFun", "NotFn", expr.ast, fnValue)
      local fenv, body = unpack(fnValue)
      return eval(body, envBind(fenv, ee(arg)))
   elseif typ == "INat" then
      local nfn, args = expr[1], expr[2]
      return nfn(unpack(imap(args, ee)))
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

   if value.T == "VVec" then
      local o = imap(value, valueFmt)
      return "[" .. concat(o, ", ") .. "]"
   elseif value.T == "VRec" then
      local o = {}
      for _, pair in ipairs(value) do
         o[#o+1] = tostring(pair[1]) .. ": " .. valueFmt(pair[2])
      end
      return "{" .. concat(o, ", ") .. "}"
   elseif value.T == "VFun" then
      local fenv, body = unpack(value)
      return ("(...) -> %s"):format(ilFmt(body))
   elseif value.T == "VErr" then
      return "(VErr " .. astFmtV(value) .. ")"
   end
end

function valueType(value)
   local typ = type(value)
   if typ == "table" then
      return value.T
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
      error({T="VErr", typ, where or {}, what})
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
   local body = {T="INat", nativeMethod, {{T="IArg", 1}, {T="IArg", 0}}}
   return function (value)
      return {T="VFun", envBind(emptyEnv, value), body}
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
   ["not"] = function (b) return not b end,
}

local boolBinops = {
   ["{}or"] = function (a, b) return a or b end,
   ["{}and"] = function (a, b) return a and b end,
   ["{}=="] = function (a, b) return a == b end,
   ["{}!="] = function (a, b) return a ~= b end,
}

local boolMethods = {
   switch = function (self, args)
      faultIf(#args ~= 2, "SwitchArity", nil, args[3])
      return self and args[1] or args[2]
   end,

   ["{}[]"] = function (self, args)
      local offset = args[1]
      faultIf(valueType(offset) ~= "number", "NotNumber", nil, offset)
      faultIf(offset < 0 or offset >= #self, "Bounds", nil, offset)
      return self:byte(offset+1)
   end,
}

behaviors.boolean = makeBehavior(boolUnops, boolBinops, boolMethods, "boolean")

--------------------------------
-- VStr  (happens to be Lua string)
--------------------------------

local strUnops = {
   len = function (v) return #v end,
}

-- "Operators" operate on two values of the same type
local strBinops = {
   ["{}<"] = function (a, b) return a < b end,
   ["{}=="] = function (a, b) return a == b end,
   ["{}!="] = function (a, b) return a ~= b end,
   ["{}<="] = function (a, b) return a <= b end,
   ["{}<"] = function (a, b) return a < b end,
   ["{}>="] = function (a, b) return a >= b end,
   ["{}>"] = function (a, b) return a > b end,
   ["{}++"] = function (a, b) return a .. b end,
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

   ["{}[]"] = function (self, args)
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

local numUnops = {
   ["-"] = function (a) return -a end,
}

local numBinops = {
   ["{}^"] = function (a, b) return a ^ b end,
   ["{}*"] = function (a, b) return a * b end,
   ["{}/"] = function (a, b) return a / b end,
   ["{}//"] = function (a, b) return math.floor(a / b) end,
   ["{}%"] = function (a, b) return a % b end,
   ["{}+"] = function (a, b) return a + b end,
   ["{}-"] = function (a, b) return a - b end,
   ["{}<"] = function (a, b) return a < b end,
   ["{}=="] = function (a, b) return a == b end,
   ["{}!="] = function (a, b) return a ~= b end,
   ["{}<="] = function (a, b) return a <= b end,
   ["{}<"] = function (a, b) return a < b end,
   ["{}>="] = function (a, b) return a >= b end,
   ["{}>"] = function (a, b) return a > b end,
}

behaviors.number = makeBehavior(numUnops, numBinops, {}, "number")

-- Construct a VNum or VStr
--
local function newValue(nativeValue)
   if type(nativeValue) == "number" then
      return nativeValue
   else
      return tostring(nativeValue)
   end
end

--------------------------------
-- VVec
--------------------------------

local vecUnops = {
   len = function (v) return #v end,
}

local vecBinops = {
   ["{}++"] = function (a, b)
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
      return {T="VVec", unpack(self, start+1, limit)}
   end,

   set = function (self, args)
      local index, value = args[1], args[2]
      faultIf(valueType(index) ~= "number", "NotNumber", nil, index)
      -- enforce contiguity (growable, but one at a time)
      faultIf(index < 0 or index > #self, "Bounds", nil, index)
      local v = clone(self)
      v[index+1] = value
      return v
   end,

   ["{}[]"] = function (self, args)
      local offset = args[1]
      faultIf(valueType(offset) ~= "number", "NotNumber", nil, offset)
      faultIf(offset < 0 or offset >= #self, "Bounds", nil, offset)
      return self[offset+1]
   end,
}

behaviors.VVec = makeBehavior(vecUnops, vecBinops, vecMethods, "VVec")

function natives.vvecNew(...)
   return {T="VVec", ...}
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
local tv1 = natives.vvecNew(newValue(9), newValue(8))
test.eq(tv1, {T="VVec", 9, 8})
test.eq(natives.vvecNth(tv1, newValue(0)), newValue(9))

--------------------------------
-- VRec
--------------------------------

local vrecEmpty = {T="VRec"}

local function recFindPair(rec, name)
   for ndx, pair in ipairs(rec) do
      if pair[1] == name then
         return ndx
      end
   end
end

local recBinops = {
}

local recMethods = {
   setProp = function (self, args)
      local name, value = args[1], args[2]
      faultIf(valueType(name) ~= "string", "NotString", nil, name)
      local ndx = recFindPair(self, name)
      return clone(self, {[ndx or #self+1] = {name, value}})
   end,
}

local recBase = makeBehavior({}, recBinops, recMethods, "VRec")

behaviors.VRec = function (value, name)
   local ndx = recFindPair(value, name)
   if ndx then
      return value[ndx][2]
   end
   return recBase(value, name)
end

function natives.vrecNew(names, values)
   local v = {T="VRec"}
   for ii, name in ipairs(names) do
      v[ii] = {name, values[ii]}
   end
   return v
end

-- recDef: names -> values -> record
function natives.recDef(names)
   return {
      T="VFun",
      emptyEnv,
      {T="INat", natives.vrecNew, {{T="IVal", names}, {T="IArg", 0}}}
   }
end

--------------------------------
-- Store names of native functions for debugging
--------------------------------

for name, fn in pairs(natives) do
   nfnNames[fn] = name
end

----------------------------------------------------------------
-- desugarM: Middle Language to Inner Language
----------------------------------------------------------------
--
-- Translation from ML to IL involves the following (among others):
--
--  * Named variable references are converted to de Bruijn indices. At this
--    stage, undefined variable references and shadowing violations are
--    detected.
--
--  * Multi-argument ML functions are described in terms of single-argument
--    IL functions that accept an argument bundle (currently just a vector).
--

--------------------------------
-- Scope object
--------------------------------

local emptyScope = {
   depth = 0,
   macros = {},
}

local function scopeExtend(scope, names)
   local s = clone(scope)
   local depth = scope.depth + 1
   s.depth = depth
   for ii, name in ipairs(names) do
      s[name] = {depth = depth, offset = ii-1}
   end
   return s
end

local function scopeFind(scope, name)
   local defn = scope[name]
   if defn then
      return scope.depth - defn.depth, defn.offset
   end
end

--------------------------------
-- DesugarM
--------------------------------

local builtins = {
   -- Just return the arg bundle (currently the same as a vector)
   [".vecNew"] = {T="VFun", emptyEnv, {T="IArg", 0}},
   [".recDef"] = {T="VFun", emptyEnv, {T="INat",
                                       assert(natives.recDef),
                                       {{T="IArg", 0}}}},
}

local function mnameToString(ast)
   assert(ast.T == "MName")
   return ast[1]
end

-- Return array of variable names assigned within `node`
--
local function findLets(node)
   local typ = node.T
   local vars = {}
   local subexprs = {}
   if typ == "MFun" then
      local params, body = node[1], node[2]
      vars = params
      subexprs = {body}
   elseif typ == "MCall" then
      local fn, args = node[1], node[2]
      subexprs = append({fn}, args)
   elseif typ == "MProp" then
      local value, name = node[1], node[2]
      subexprs = {value}
   elseif typ == "MLoop" then
      local body, k = node[1], node[2]
      subexprs = {body, k}
   end

   for _, e in ipairs(subexprs) do
      vars = append(vars, findLets(e))
   end
   return vars
end

local function mbreak(loopVars)
   return mcall(mname".post", imap(loopVars, mname))
end

local function mrepeat(loopVars)
   return mcall(mname".body", imap(append({".body"}, loopVars), mname))
end

-- Reduce an MLoop expression to other ML expressions
--
--  (Loop BODY K) =->
--     .post = (VARS) -> K
--     break ~~> .post(VARS)
--     repeat ~~> .body(body, VARS)
--     .body = (.body, VARS) -> BODY
--     repeat
--
local function reduceMLoop(body, k, vars)
   return mlet(".post", {T="MFun", vars, k},
               mlet(".body", {T="MFun", append({".body"}, vars), body},
                    mrepeat(vars)))
end

local function desugarM(node, scope)
   local function ds(a)
      return desugarM(a, scope)
   end

   local function N(typ, ...)
      return {T=typ, ast=node.ast, ...}
   end

   local function nat(name, args)
      return N("INat", assert(natives[name]), args)
   end

   local function isDefined(name)
      return nil ~= scopeFind(scope, name)
   end

   local typ = node.T

   if typ == "MName" then
      local name = node[1]
      if builtins[name] then
         return {T="IVal", builtins[name]}
      end
      if scope.macros[name] then
         return ds(scope.macros[name])
      end
      local index, offset = scopeFind(scope, name)
      faultIf(index == nil, "Undefined", node.ast, name)
      return nat("vvecNth", {N("IArg", index), N("IVal", newValue(offset))})
   elseif typ == "MVal" then
      local value = node[1]
      return N("IVal", newValue(value))
   elseif typ == "MFun" then
      local params, body, shadowMode = node[1], node[2], node[3]
      -- check for un-sanctioned shadowing
      for _, name in ipairs(params) do
         if shadowMode == "=" then
            faultIf(isDefined(name), "Shadow", node.ast, name)
         elseif shadowMode == ":=" then
            faultIf(not isDefined(name), "Undefined", node.ast, name)
         end
      end
      return N("IFun", desugarM(body, scopeExtend(scope, params)))
   elseif typ == "MCall" then
      local fn, args = node[1], node[2]
      return N("IApp", ds(fn), nat("vvecNew", imap(args, ds)))
   elseif typ == "MProp" then
      local value, name = node[1], node[2]
      return nat("getProp", {ds(value), N("IVal", name)})
   elseif typ == "MLoop" then
      local body, k = node[1], node[2]
      local vars = ifilter(findLets(body), isDefined)
      local macros = {
         ["break"] = mbreak(vars),
         ["repeat"] = mrepeat(vars),
      }
      return desugarM(reduceMLoop(body, k, vars), clone(scope, {macros=macros}))
   elseif typ == "MError" then
      local desc, ast = node[1], node[2]
      faultIf(true, "Error: " .. desc, ast, nil)
   else
      test.fail("unknown M-record: %s", mlFmt(node))
   end
end

local function desugar(ast, scope)
   return desugarM(desugarExpr(ast), scope)
end

----------------------------------------------------------------
-- Tests
----------------------------------------------------------------

local function fmtLet(name, value, expr, shadowMode)
   shadowMode = shadowMode and ' "' .. shadowMode .. '"' or ""
   return ('(MCall (MFun ["%s"] %s%s) [%s])'):format(
      name, expr, shadowMode, value)
end

local function evalAST(ast)
   local manifest = {
      ["true"] = true,
      ["false"] = false,
   }

   -- create `scope` and `env` for manifest
   local names = misc.getSortedKeys(manifest)
   local values = imap(names, function (k) return manifest[k] end)
   local scope = scopeExtend(emptyScope, names)
   local env = envBind(emptyEnv, natives.vvecNew(unpack(values)))

   return eval(desugar(ast, scope), env)
end

local function trapEval(fn, ...)
   local succ, value = xpcall(fn, debug.traceback, ...)
   if not succ and type(value) == "string" then
      -- re-throw
      error(value, 0)
   end
   return value
end

local function et(source, evalue, eoob)
   local source = source:gsub(" | ", "\n")
   local ast, oob = syntax.parseModule(source)
   test.eqAt(2, eoob or "", astFmtV(oob or {}))
   test.eqAt(2, evalue, valueFmt(trapEval(evalAST, ast)))
end

-- manifest variables

et("true", 'true')

-- parse error

et(".5", "0.5", '(Error "NumDigitBefore")')

-- eval error

et("x", '(VErr "Undefined" [] "x")')

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
et("(2==2).switch(1,0)", "1")
et("(2==3).switch(1,0)", "0")

-- ... Number
et("1 + 2", "3")
et("7 // 3", "2")
et("-(1)", "-1")
et("1 < 2", "true")
et("1 < 2 < 3", "true")

-- ... String
et(' "abc" ++ "def" ', '"abcdef"')
et(' "abc".len ', '3')
et(' "abcd".slice(1, 3) ', '"bc"')
et(' "abc" == "abc" ', 'true')
et(' "abc"[1] ', '98')

-- ... Vector
et("[7,8,9].len", "3")
et("[7,8,9,0].slice(1,3)", "[8, 9]")
et("[7,8,9,0].slice(1,1)", "[]")
et("[7,8,9].set(1, 2)", "[7, 2, 9]")
et("[7,8,9][1]", "8")

-- ... Record
et("{a:1}.a", "1")
et('{a:1}.setProp("b",2).setProp("a",3)', "{a: 3, b: 2}")

-- Fn

et("x -> x", "(...) -> $0[0]")

-- Function calls

et("(x -> 1)(2)", "1")
et("(x -> x+1)(2)", "3")
et("(x -> x+1) $ 2", "3")

-- If

et("if 1 < 2: 1 | 0", "1")
et("if 1 < 0: 1 | 0", "0")

-- Let

et("x = 1 | x + 2 | ", "3")
et("x = 1 | x := 2 | x + 2 | ", "4")
et("x = 1 | x += 2 | x + 2 | ", "5")
et("x = 1 | x = 2 | x | ", '(VErr "Shadow" [] "x")')
et("x := 1 | x | ", '(VErr "Undefined" [] "x")')

local var, val = peelTarget(
   {T="Dot", {T="Index", {T="Name", "x"}, {T="Number", "1"}}, {T="Name","a"}},
   mval(9))
test.eq(var, {T="Name", "x"})
test.eq(val, msend(mname"x", "set",
                   {mval(1), msend(msend(mname"x", "{}[]", {mval(1)}),
                                   "setProp",
                                   {mval"a", mval(9)})}))

et("x = [1,2] | x[0] := 3 | x | ", "[3, 2]")
et("x = {a:[1]} | x.a[1] := 2 | x", "{a: [1, 2]}")

-- Loop

local loop0 = [[
loop:
  x := 1
x
]]
test.eq(mlFmt(desugarExpr(syntax.parseModule(loop0))),
        '(MLoop (MCall (MFun ["x"] repeat ":=") [(MVal 1)]) x)')

test.eq(findLets({T="MCall",
                  {T="MFun", {"x", "y"}, {T="MVal", nil}, true},
                  {{T="MFun", {"z"}, {T="MVal", nil}, true}}}),
        {"x", "y", "z"})

test.eq(mlFmt(reduceMLoop({T="MName", "break"}, {T="MName", "x"}, {"x"})),
        fmtLet(".post",
               '(MFun ["x"] x)',
               fmtLet(".body",
                      '(MFun [".body" "x"] break)',
                      '(MCall .body [.body x])')))

et([[
x = 1
loop while x < 10:
  x *= 2
x
]],
   '16')

-- Examples

local fibr = [[

_fib = (_self, n) ->
    fib = n2 -> _self(_self, n2)
    if n <= 1: 0
    if n == 2: 1
    fib(n - 1) + fib(n - 2)

fib = n -> _fib(_fib, n)

fib(8)

]]

et(fibr, "13")

local fibloop = [==[

fib = n ->
    a = [0, 1]
    loop while n > 1:
        a := [a[1], a[0]+a[1]]
        n := n-1
    a[0]

fib(8)

]==]

et(fibloop, "13")
