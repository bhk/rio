// Load and evaluate a Rio program and display the result

import fs from "fs";
import {astFmt, astFmtV, parseModule} from "./syntax.js";
import {Env, IL} from "./desugar.js";
import {evalAST, valueFmt} from "./interp.js";
import {eq, assert, printf} from "./test.js";

let getLineInfo = (text, pos) => {
    let prefix = text.slice(0, pos);
    let line = (prefix.match(/\n/g) || []).length + 1;
    let col = prefix.match(/[^\n]*$/)[0].length + 1;
    let lineText = text.slice(pos - col + 1).match(/^[^\n]*/)[0];
    return [line, col, lineText];
};

eq(getLineInfo("a\nb\nthi*s is a test\n", 7),
   [3, 4, "thi*s is a test"]);


// Convert array [<e0>, <e1>, ...] to {a0: <e0>, a1: <e0>, ...}
let argMap = (args) => {
    let obj = {};
    for (let n = 0; n < args.length; ++n) {
        obj["a" + n] = args[n];
    }
    return obj;
};

eq(argMap(["x", "y"]), {a0: "x", a1: "y"});


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

// Convert n to 3-digit decimal representation
let zpad = (length, n) => {
    return ("0").repeat(Math.max(length - String(n).length, 0)) + n;
};

eq("01", zpad(2,1));
eq("123", zpad(2, 123));

// Display a result's value and breakdown (recursively)
let showResult = (fileName, text, ev, result) => {
    let recur = (prefix, result) => {
        if (!(result && result.ast)) return;
        let {ast, value} = result;
        let f = astBreakdowns[ast.T];
        let [template, children] = (f ? f(...ast) : []);

        let [line, col, lineText] = getLineInfo(text, ast.pos);
        let colHere = zpad(2, col) + "-" + zpad(2, col + ast.end - ast.pos);
        let here = "@" + zpad(3, line) + ":" + colHere + ":";

        printf("%s%s%s\n", here, prefix, (value ? valueFmt(value) : "<undefined>"));
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
    let ev = evalAST(ast);
    let value = ev.sync();

    // display value
    if (value.T != "VErr") {
        printf("%s\n", valueFmt(value));
        return 0;
    }

    // describe error
    let result = ev.where();
    let [line, col, lineText] = getLineInfo(text, result.ast.pos);

    if (value.desc == "Stop" && result.ast.T == "S-Assert") {
        printf("%s:%s:%s: Assertion failed\n", fileName, line, col);
        printf(" | %s\n", lineText);
        let [cond] = result.ast;
        showResult(fileName, text, ev, ev.getResult(result, cond));
    } else {
        printf("%s:%s:%s: Error: %q\n", fileName, line, col, value.desc);
        showResult(fileName, text, ev, result);
    }
    return 1;
};

// Main

let [fileName, ...more] = process.argv.slice(2);

if (fileName) {
    let text = fs.readFileSync(fileName, {encoding: "utf8"});
    process.exit(runText(text, fileName));
} else {
    printf("rio.js: No file name given\n\nUsage: node rio.js <filename>\n");
    process.exit(1);
}
