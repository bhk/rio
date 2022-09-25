// run: terminal command to execute a Rio program

import {Env as DSEnv, IL} from "./desugar.js";
import {ilEval, evalEnvBind, evalEnvGet} from "./eval.js";
import {eq, assert, sprintf, printf} from "./test.js";

//================================================================
// Render IL to terminal
//================================================================

let printIL = (expr, where, trace) => {

    let getTagResult = (ast) => {
        for (let t of trace) {
            let op = t.frame.expr[t.ii];
            if (op.ast == ast) {
                return valueFmt(t.value);
            }
        }
        return "?";
    };

    let printExpr = (expr, prefix) => {
        let depth = 0;

        let printOp = (op, ii) => {
            depth += 1 - (op.T == "App" ? op.nargs + 1 :
                          op.T == "Tag" ? 1 : 0);

            if (op.T == "Fun") {
                printExpr(op.body, prefix + "   ");
            }

            let line = prefix + "[" + depth + "] "
                + (op.T == "Fun" ? "Fun ^" : IL.fmtOp(op))
                + (op.T == "Tag" ? " = " + getTagResult(op.ast) : "");

            let isHere = ii == where.ii && expr == where.frame.expr;

            printf("%s %s%s\n",
                   isHere ? "***" : "   ",
                   line,
                   (isHere && where.errorName
                    ? (" ").repeat(12) + "*** Error: " + where.errorName
                    : ""));
        };

        expr.forEach(printOp);
    };
    printExpr(expr, "");
};

let printProgram = (topExpr, ev) => {
    let r = ev.getResult();
    let st = ev.getState();
    let pos = r.errorName ? st.error : r;
    printIL(topExpr, pos, st.trace);
};

//================================================================
// Terminal-based source-level diagnostics and inspection
//================================================================

let argNames = (args) => args.map((_,n) => "a" + (n+1));

let argList = (args) =>
    argNames(args).map(name => "<" + name + ">").join(", ");

// Convert array [<e0>, <e1>, ...] to {a0: <e0>, a1: <e0>, ...}
let argMap = (args) => {
    let obj = {};
    argNames(args).forEach((name, n) => {
        obj[name] = args[n];
    });
    return obj;
};

// astBreakdowns[ast.T](...ast) -->  [template, childNamesAndValues]
//
let astBreakdowns = {
    Binop: ({op, a, b}) => ["<a> " + op + " <b>", {a, b}],
    Unop: ({op, a}) =>     [op + " <a>", {a}],
    Dot: ({a, name}) =>    ["<a>." + astName_string(name), {a}],
    Index: ({a, b}) =>     ["a[b]", {a, b}],
    IIf: ({cond, a, b}) => ["<cond> ? <a> : <b>", {cond, a}],
    Call: ({fn, args}) =>  ["<f>(" + argList(args) + ")",
                            {f: fn, ...argMap(args)}],
    Vector: ({elems}) =>   ["{<aN>...}", argMap(elems)],

    Number: ({str}) => [false],
    Name: ({str}) => [false],
    String: ({str}) => [false],
    Map: ({kvs}) => [],
    Match: ({value, cases}) =>  [],
    Missing: () =>  [],
    Error: ({str}) =>  [],
    Fn: ({params, body}) =>  [],
    Block: ({block}) => [],
};

let getLineInfo = (text, pos) => {
    let prefix = text.slice(0, pos);
    let line = (prefix.match(/\n/g) || []).length + 1;
    let col = prefix.match(/[^\n]*$/)[0].length + 1;
    let lineText = text.slice(pos - col + 1).match(/^[^\n]*/)[0];
    return [line, col, lineText];
};

let lineAndCol = (text, ast) => {
    let [line, col, lineText] = getLineInfo(text, ast.pos);
    let colHere = zpad(2, col) + "-" + zpad(2, col + ast.end - ast.pos);
    return zpad(3, line) + ":" + colHere;
};

// Convert n to 3-digit decimal representation
let zpad = (length, n) => {
    return ("0").repeat(Math.max(length - String(n).length, 0)) + n;
};

// Display a result's value and breakdown (recursively)
//
//        value
//        = <template>          \
//          a: <b>               |-- breakdown
//          b: <b>              /
//        = <template>         function body continuation
//          b: <B>
//        ...
//
let printResult = (fileName, text, ev, result) => {
    let recur = (prefix, result) => {
        if (!result) {
            return;
        }

        let value = result.value;
        let here = lineAndCol(text, result.getAST()) + ":";
        printf("%s%s%s\n", here, prefix,
               (value ? valueFmt(value) : "<undefined>"));
        let p2 = prefix.replace(/./g, " ");

        // print breakdowns

        do {
            let ast = result.getAST();
            let f = astBreakdowns[ast.T];
            let [template, childASTs] = (f ? f(ast) : []);
            let here = lineAndCol(text, ast) + ":";

            // print template

            if (template === false) {
                break;
            }
            template = template || "[" + ast.T + "]";
            printf("%s%s= %s\n", here, p2, template);

            // print members

            let cmap = new Map();
            for (let r of result.getChildren()) {
                cmap.set(r.getAST(), r);
            }
            for (let [name, ast] of Object.entries(childASTs || [])) {
                let r = cmap.get(ast);
                if (r) {
                    cmap.delete(ast);
                    recur(p2 + "  " + name + ": ", r);
                } else {
                    printf("Child not found: %q\n", ast);
                }
            }

            // if a child result is left over (not one of the children in
            // the breakdown) and it has the same value, we treat it as the
            // 'body' of the current result, and show its breakdown below.

            // result = cmap.values().next().value;
            result = null;
            for (let r of cmap.values()) {
                if (r.value === value) {
                    result = r;
                    break;
                }
            }

        } while (result);
    };
    recur(" ", result);
};

let findChildResult = (result, ast) => {
    for (let r of result.children) {
        if (r.getAST() == ast) {
            return r;
        }
    }
};

//================================================================
// Parse and execute a source file
//================================================================

import fs from "fs";
import {astFmt, astFmtV} from "./ast.js";
import {parseModule} from "./parse.js";
import {Host, valueFmt} from "./host.js";

// Construct matching desugar env & eval env from {varName -> hostValue}
let makeManifest = (vars) => {
    let names = Object.keys(vars).sort();
    let values = names.map(k => vars[k]);
    return [new DSEnv(names), evalEnvBind({}, values)];
};

let manifestVars = {
    "true": Host.VBool(true),
    "false": Host.VBool(false),
};

let [manifestDSEnv, manifestEvalEnv] = makeManifest(manifestVars);

let runText = (text, fileName) => {
    let [programAST, oob] = parseModule(text);

    // Display out-of-band parsing errors (filter out comments)
    oob = oob.filter(e => e.T == "Error");
    if (oob.length > 0) {
        for (let err of oob) {
            let [desc] = err;
            let [line, col, lineText] = getLineInfo(text, err.pos);
            printf("%s:%s:%d: Error: %s\n", fileName, line, col, desc);
            printf(" | %s\n", lineText);
            printf(" | %s^\n", (" ").repeat(col-1));
        }
        return 1;
    }

    // evaluate program
    let programIL = manifestDSEnv.desugar(programAST);
    let ev = ilEval(Host)(programIL, {}, manifestEvalEnv);
    ev.sync();
    let result = ev.getResult();

    assert(result);

    if (process.env["DUMP"]) {
        printProgram(programIL, ev);
    }

    // display value
    if (!result.errorName) {
        printf("%s\n", valueFmt(assert(result.value)));
        return 0;
    }

    // describe error
    let errAST = result.getAST();
    let [line, col, lineText] = getLineInfo(text, errAST.pos);

    if (result.errorName == "Stop" && errAST.T == "S-Assert") {
        printf("%s:%s:%s: Assertion failed\n", fileName, line, col);
        printf(" | %s\n", lineText);
        let {cond} = errAST;
        printResult(fileName, text, ev, findChildResult(result, cond));
    } else {
        printf("%s:%s:%s: Error: %q\n", fileName, line, col, result.errorName);
        printResult(fileName, text, ev, result);
    }
    return 1;
};

let main = () => {
    let [fileName, ...more] = process.argv.slice(2);

    if (fileName) {
        let text = fs.readFileSync(fileName, {encoding: "utf8"});
        process.exit(runText(text, fileName));
    } else {
        printf("rio.js: No file name given\n\nUsage: node rio.js <filename>\n");
        process.exit(1);
    }
};

//--------------------------------
// Tests
//--------------------------------

eq(getLineInfo("a\nb\nthi*s is a test\n", 7),
   [3, 4, "thi*s is a test"]);

eq(argMap(["x", "y"]), {a1: "x", a2: "y"});

eq("01", zpad(2,1));
eq("123", zpad(2, 123));

//--------------------------------
// Main
//--------------------------------

main();
