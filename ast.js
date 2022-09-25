// ast: construct and serialize AST nodes

// Notes:
//
//  - After construction of an AST node, the parser populates fields
//    named `pos` and `end`.  These do not appear in the serialization.
//  - `kvs` is a flat array of keys and values.
//  - `block` is an array of statements/expressions
//  - `body` is an expression
//  - `name` is a Name
//  - `op` & `str` are strings

import {eq, serialize} from "./test.js";

let AST = {
    // Expressions
    Binop: (op, a, b)         => ({T:"Binop", op, a, b}),
    Block: (block)            => ({T:"Block", block}),
    Call: (fn, args)          => ({T:"Call", fn, args}),
    Dot: (a, name)            => ({T:"Dot", a, name}),
    Fn: (params, body)        => ({T:"Fn", params, body}),
    IIf: (cond, a, b)         => ({T:"IIf", cond, a, b}),
    Index: (a, b)             => ({T:"Index", a, b}),
    Map: (kvs)                => ({T:"Map", kvs}),
    Match: (value, cases)     => ({T:"Match", value, cases}),
    Missing: ()               => ({T:"Missing"}),
    MissingBlock: ()          => ({T:"MissingBlock"}),
    Name: (str)               => ({T:"Name", str}),
    Number: (str)             => ({T:"Number", str}),
    Op: (op, a, b)            => ({T:"Op", op, a, b}),
    String: (str)             => ({T:"String", str}),
    Unop: (op, a)             => ({T:"Unop", op, a}),
    VecPattern: (elems)       => ({T:"VecPattern", elems}),
    Vector: (elems)           => ({T:"Vector", elems}),

    // Statements (these appear in Block)
    SAct: (params, act)       => ({T:"S-Act", params, act}),
    SAssert: (cond)           => ({T:"S-Assert", cond}),
    SCase: (pattern, body)    => ({T:"S-Case", pattern, body}),
    SFor: (name, seq, body)   => ({T:"S-For", name, seq, body}),
    SIf: (cond, then)         => ({T:"S-If", cond, then}),
    SLet: (target, op, value) => ({T:"S-Let", target, op, value}),
    SLoop: (block)            => ({T:"S-Loop", block}),
    SLoopWhile: (cond, block) => ({T:"S-LoopWhile", cond, block}),
    SWhile: (cond)            => ({T:"S-While", cond}),

    // OOB records
    Comment: (text)          => ({T:"Comment", text}),
    Error: (str)             => ({T:"Error", str}),
};

let astFmtV = (nodes) => nodes.map(astFmt).join(" ");

let astFmt = (value) => {
    if (typeof value != "object") {
        return serialize(value);
    } else if (value instanceof Array) {
        return "[" + astFmtV(value) + "]";
    } else if (value.T == "Name" || value.T == "Number") {
        return value.str;
    }
    let txt = Object.entries(value)
        .filter( ([k,v]) => k != "pos" && k != "end")
        .map( ([k,v]) => k == "T" ? v : astFmt(v))
        .join(" ");
    return "(" + txt + ")";
};

eq(astFmt(AST.Fn([AST.Name("x"), AST.Name("y")],
                 AST.Number(9))),
   "(Fn [x y] 9)");

export {AST, astFmt, astFmtV};
