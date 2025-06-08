// AST: construct and serialize AST nodes
//
//  - `kvs` is a flat array of keys and values.
//  - `block` is an array of statements/expressions
//  - `body` is an expression
//  - `name` is a Name
//  - `op` & `str` are strings
//

import { eq, serialize } from "./test.js";

class AST {
    constructor(typ, props) {
        this.T = typ;
        for (const [key, value] of Object.entries(props)) {
            this[key] = value;
        }
    }

    setPos(pos, end) {
        this.pos = pos;
        this.end = end;
        return this;
    }
};

// Expressions
AST.Binop = (op, a, b)         => new AST("Binop", {op, a, b});
AST.Block = (block)            => new AST("Block", {block});
AST.Call = (fn, args)          => new AST("Call", {fn, args});
AST.Dot = (a, name)            => new AST("Dot", {a, name});
AST.Fn = (params, body)        => new AST("Fn", {params, body});
AST.IIf = (cond, a, b)         => new AST("IIf", {cond, a, b});
AST.Index = (a, b)             => new AST("Index", {a, b});
AST.Map = (kvs)                => new AST("Map", {kvs});
AST.Match = (value, cases)     => new AST("Match", {value, cases});
AST.Missing = ()               => new AST("Missing", {});
AST.MissingBlock = ()          => new AST("MissingBlock", {});
AST.Name = (str)               => new AST("Name", {str});
AST.Number = (str)             => new AST("Number", {str});
AST.Op = (op, a, b)            => new AST("Op", {op, a, b});
AST.String = (str)             => new AST("String", {str});
AST.Unop = (op, a)             => new AST("Unop", {op, a});
AST.VecPattern = (elems)       => new AST("VecPattern", {elems});
AST.Vector = (elems)           => new AST("Vector", {elems});

// Statements (these appear in Block)
AST.SAct = (params, act)       => new AST("S-Act", {params, act});
AST.SAssert = (cond)           => new AST("S-Assert", {cond});
AST.SCase = (pattern, body)    => new AST("S-Case", {pattern, body});
AST.SFor = (name, seq, body)   => new AST("S-For", {name, seq, body});
AST.SIf = (cond, then)         => new AST("S-If", {cond, then});
AST.SLet = (target, op, value) => new AST("S-Let", {target, op, value});
AST.SLoop = (block)            => new AST("S-Loop", {block});
AST.SLoopWhile = (cond, block) => new AST("S-LoopWhile", {cond, block});
AST.SWhile = (cond)            => new AST("S-While", {cond});

// OOB records
AST.Comment = (text)          => new AST("Comment", {text});
AST.Error = (str)             => new AST("Error", {str});

AST.isOOB = {
    Comment: true,
    Error: true,
};

const astFmtV = (nodes) => nodes.map(astFmt).join(" ");

const astFmt = (value) => {
    if (Array.isArray(value)) {
        return "[" + astFmtV(value) + "]";
    } else if (typeof value != "object") {
        return serialize(value);
    } else if (value instanceof AST) {
        if (value.T == "Name" || value.T == "Number") {
            return value.str;
        }
        const txt = Object.entries(value)
              .filter( ([k,v]) => k != "pos" && k != "end")
              .map( ([k,v]) => k == "T" ? v : astFmt(v))
              .join(" ");
        return "(" + txt + ")";
    } else {
        const txt = Object.entries(value)
              .map( ([k,v]) => k + ": " + astFmt(v) )
              .join(", ");
        return "{" + txt + "}";
    }
};

eq(astFmt({node: AST.Fn([AST.Name("x"), AST.Name("y")],
                        AST.Number(9))}),
   "{node: (Fn [x y] 9)}");

export { AST, astFmt, astFmtV };
