local test = require "test"
local syntax = require "syntax"
local persist = require "persist"

local imap, override = persist.imap, persist.override

----------------------------------------------------------------
-- Primitive types
----------------------------------------------------------------

-- Boolean: boolean
-- Number: number
-- String: string
-- Vector: array    TODO:  {[0]="Array", ...}
-- Record: table    TODO: {[0]="Record", ...}
-- Function: table  {[0]="Fn", env, params, body}

----------------------------------------------------------------
-- Evaluation of expressions
----------------------------------------------------------------

-- AST expression nodes:
--
--   (Name str)
--   (Missing)
--   (Number str)
--   (String str)
--   (Vector [items...])
--   (Record [name value ...])
--   (Fn [params...] body)
--   (Op_X a b)
--   (Unop_X a)
--   (Elvis a b c)
--
--   (For [name seq body] k)
--   (If [cond then] k)
--   (LoopWhile [cond body] k)
--   (While [cond] k)
--   (Let [name op value] k)
--   (Act [params act] k)
--   (Ignore [expr] k)

-- Core language:
--   (Value ...)
--   (Call fn args)
--   (Up level nth)
--


local numOps = {
   ["Op_-"] = function (a, b) return a - b end,
   ["Op_+"] = function (a, b) return a + b end,
   ["Op_<"] = function (a, b) return a < b end,
   ["Op_<="] = function (a, b) return a <= b end,
   ["Op_>="] = function (a, b) return a >= b end,
   ["Op_=="] = function (a, b) return a == b end,
}


local function evalInEnv(node, env, subj)
   -- test.printf("env: %Q\n", env)

   local function eval(node)
      local typ = node.type
      if typ == "Name" then
         assert(env[node[1]])
         return env[node[1]]
      elseif typ == "Number" then
         return tonumber(node[1])
      elseif typ == "String" then
         return node[1]
      elseif typ == "Fn" then
         return {
            [0] = "Fn",
            env = env,
            params = node[1],
            body = node[2],
         }
      elseif typ == "Op_()" then
         local fn = eval(node[1])
         local argNodes = node[2]
         test.eq(fn[0], "Fn")
         test.eq(#argNodes, #fn.params)
         -- construct new bindings
         local e = {}
         for ii, param in ipairs(fn.params) do
            test.eq(param.type, "Name")
            e[param[1]] = eval(argNodes[ii])
         end
         local newEnv = persist.override({}, fn.env, e)
         return evalInEnv(fn.body, newEnv, subj)
      elseif numOps[typ] then
         local a, b = eval(node[1]), eval(node[2])
         test.eq(type(a), "number")
         test.eq(type(b), "number")
         return numOps[typ](a, b)
      elseif typ == "Vector" then
         return persist.imap(node[1], eval)
      elseif typ == "Record" then
         local pairs = node[1]
         local o = {}
         for i = 1, #pairs, 2 do
            local name, value = pairs[i], pairs[i+1]
            assert(name.type == "Name")
            o[name[1]] = eval(value)
         end
         return o
      elseif typ == "If" then
         local cond = eval(node[1][1])
         local thenNode, elseNode = node[1][2], node[2]
         test.eq(type(cond), "boolean")
         if cond == true then
            return eval(thenNode)
         else
            return eval(elseNode)
         end
      elseif typ == "Let" then
         local nameNode, op, valueNode = table.unpack(node[1])
         local k = node[2]
         test.eq(nameNode.type, "Name")
         local name = nameNode[1]
         local value = eval(valueNode)
         return evalInEnv(k, persist.override({}, env, {[name] = value}), subj)
      else
         test.fail("Unknown node type: %Q", typ)
      end
   end

   return eval(node)
end


local initialEnv = {
}

----------------------------------------------------------------
-- Tests
----------------------------------------------------------------

local function et(source, evalue)
   test.eqAt(2, evalue, evalInEnv(syntax.parseModule(source), initialEnv, source))
end

et("1.23", 1.23)
et([["abc"]], "abc")
et("1 + 2", 3)
et("1 < 2", true)
et("[1,2,3]", {1,2,3})
et("{a: 1, b: 2}", {a= 1, b= 2})

-- Fn

et("x => x", {[0] = "Fn",
              env = {},
              params = { {type="Name", pos=1, "x"} },
              body = {type="Name", pos=6, "x"} })

-- Op_()

et("(x => 1)(2)", 1)
et("(x => x+1)(2)", 3)

-- If

et("if 1 < 2: 1\n0\n", 1)
et("if 1 < 0: 1\n0\n", 0)

-- Let

et("x = 1\nx + 2\n", 3)

local fib = [[
_fib = (_fib, n) =>
    fib = n => _fib(_fib, n)
    if n <= 1: 0
    if n == 2: 1
    fib(n - 1) + fib(n - 2)

fib = n => _fib(_fib, n)

fib(8)
]]

et(fib, 13)
