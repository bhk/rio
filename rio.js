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

let showResult = (text, ev, result) => {
    let prefix = "..";
    let recur = (label, result) => {
        let ast = result && result.ast;
        let value = result && result.value;
        printf("%s%s %s\n", prefix, label, (value ? valueFmt(value) : "<undefined>"));
        let oldPrefix = prefix;
        prefix += label.replace(/./g, " ") + " ";

        if (!ast) {
            // nothing
        } else if (ast.T == "Binop") {
            let [op, a, b] = ast;
            printf("%sa %s b\n", prefix, op);
            recur("a:", ev.getResult(result, a));
            recur("b:", ev.getResult(result, b));
        } else if (ast.T == "Unop") {
            let [op, a] = ast;
            printf("%s %s a\n", prefix, op);
            recur("a:", ev.getResult(result, a));
        } else {
            printf("%s(%s)\n", prefix, ast.T);
        }
        prefix = oldPrefix;
    };
    recur("", result);
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
        showResult(text, ev, ev.getResult(result, cond));
    } else {
        printf("%s:%s:%s: Error: %q\n", fileName, line, col, value.desc);
        showResult(text, ev, result);
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
