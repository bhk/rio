// run: terminal command to execute a Rio program

import {Env as DSEnv, IL} from "./desugar.js";
import {ilEval, evalEnvBind, evalEnvGet} from "./eval.js";
import {eq, assert, sprintf, printf} from "./test.js";

//================================================================
// Render IL to terminal
//================================================================

let showIL = (expr, where, trace) => {

    let formatTagResult = (ast) => {
        for (let t of trace) {
            let op = t.frame.expr[t.ii];
            if (op.ast == ast) {
                return valueFmt(t.value);
            }
        }
        return "?";
    };

    let showExpr = (expr, prefix) => {
        let depth = 0;

        let showOp = (op, extra) => {
            let desc =
                op.T == "Tag" ? ( "(" + op.n + ") " + op.ast.T + "@" + op.ast.pos
                                  + " = " + formatTagResult(op.ast)) :
                op.T == "Val" ? " " + op.type + "/" + op.arg :
                op.T == "App" ? "(" + op.nargs + ")" :
                op.T == "Arg" ? "(" + op.ops + "," + op.pos + ")" :
                "";

            depth += 1 - (op.T == "App" ? op.nargs + 1 :
                          op.T == "Tag" ? 1 : 0);

            if (op.T == "Fun") {
                showExpr(op.body, prefix + "   ");
            }

            let line = prefix + "[" + depth + "] " + op.T + desc;
            let pad = Math.max(36 - line.length, 4);

            printf("%s\n", (extra
                            ? "*** " + line + (" ").repeat(pad) + extra
                            : "    " + line));
        };

        for (let ii = 0; ii < expr.length; ++ii) {
            let op = expr[ii];
            showOp(op, (ii == where.ii
                        && expr == where.frame.expr
                        && (where.errorName
                            ? sprintf("Error: %q", where.errorName)
                            : "(here)")));
        }
    };
    showExpr(expr, "");
};

let showProgram = (topExpr, ev) => {
    let r = ev.getResult();
    let st = ev.getState();
    let pos = r.errorName ? st.error : r;
    showIL(topExpr, pos, st.trace);
};

//================================================================
// Terminal-based source-level diagnostics and inspection
//================================================================

// astBreakdowns[ast.T](...ast) -->  [template, childNamesAndValues]
//
let astBreakdowns = {
    Binop: (op, a, b) => ["<a> " + op + " <b>", {a, b}],
    Unop: (op, a) =>     [op + " <a>", {a}],
    Dot: (a, name) =>    ["<a>." + astName_string(name), {a}],
    Index: (a, b) =>     ["a[b]", {a, b}],
    IIf: (c, a, b) =>    ["<c> ? <a> : <b>", {c, a}],
    Call: (fn, args) =>  ["<f>(<aN>...)", argMap(args)],
    Vector: (elems) =>   ["{<aN>...}", argMap(elems)],

    Number: (n) => [],
    String: (str) => [],

    Map: (rpairs) =>  [],
    Match: (value, cases) =>  [],
    Missing: () =>  [],
    Error: (desc) =>  [],
    Fn: (params, body) =>  [],
    Block: (lines, loopVars) => [],
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

// Convert array [<e0>, <e1>, ...] to {a0: <e0>, a1: <e0>, ...}
let argMap = (args) => {
    let obj = {};
    for (let n = 0; n < args.length; ++n) {
        obj["a" + n] = args[n];
    }
    return obj;
};

// Convert n to 3-digit decimal representation
let zpad = (length, n) => {
    return ("0").repeat(Math.max(length - String(n).length, 0)) + n;
};

// Display a result's value and breakdown (recursively)
let showResult = (fileName, text, ev, result) => {
    let recur = (prefix, result) => {
        if (!result) {
            printf("[result = %q]\n", result);
            return;
        }

        let ast = result.getAST();
        let value = result.value;
        let f = astBreakdowns[ast.T];
        let [template, children] = (f ? f(...ast) : []);
        let here = lineAndCol(text, ast);

        printf("%s%s%s\n", here, prefix,
               (value ? valueFmt(value) : "<undefined>"));
        let p2 = prefix.replace(/./g, " ");

        if (template) {
            printf("%s%s%s\n", here, p2, template);
        }
        for (let child in children) {
            recur(p2 + child + ": ", ev.getResult(result, children[child]));
        }
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
import {astFmt, astFmtV, parseModule} from "./syntax.js";
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
    let [ast, oob] = parseModule(text);

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
    let programIL = manifestDSEnv.fromAST(ast);
    let ev = ilEval(Host)(programIL, {}, manifestEvalEnv);
    ev.sync();
    let result = ev.getResult();

    assert(result);

    if (process.env["DUMP"]) {
        showProgram(programIL, ev);
    }

    // display value
    if (!result.errorName) {
        printf("%s\n", valueFmt(assert(result.value)));
        return 0;
    }

    // describe error
    let ra = result.getAST();
    let eop = ev.getState().error;
    let [line, col, lineText] = getLineInfo(text, ra.pos);

    if (result.errorName == "Stop" && ra.T == "S-Assert") {
        printf("%s:%s:%s: Assertion failed\n", fileName, line, col);
        printf(" | %s\n", lineText);
        let [cond] = ra;
        showResult(fileName, text, ev, findChildResult(result, cond));
    } else {
        printf("%s:%s:%s: Error: %q\n", fileName, line, col, result.errorName);
        showResult(fileName, text, ev, result);
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

eq(argMap(["x", "y"]), {a0: "x", a1: "y"});

eq("01", zpad(2,1));
eq("123", zpad(2, 123));


//--------------------------------
// Main
//--------------------------------

main();
