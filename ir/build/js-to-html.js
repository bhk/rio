// usage: node js-to-html.js INFILE

import assert from "assert";
import {readFile, writeFile} from "fs/promises";

let template = [
    "<!DOCTYPE html>",
    "<html lang=en>",
    "  <head>",
    "    <meta charset=utf-8>",
    "    <meta name=viewport content='width=786'>",
    "    <title>TITLE</title>",
    "    <style>",
    "      body { margin: 0; font: 16px Arial, Helvetica; }",
    "    </style>",
    "  </head>",
    "  <body>",
    "  <script type=module>",
    "SCRIPT",
    "  </script>",
    "  </body>",
    "</html>",
    ""
].join("\n");

// Section 4.12.1.3 of https://html.spec.whatwg.org/multipage/scripting.html :
//
//   The easiest and safest way to avoid the rather strange restrictions
//   described in this section is to always escape an ASCII case-insensitive
//   match for "<!--" as "<\!--", "<script" as "<\script", and "</script" as
//   "<\/script" when these sequences appear ...
//

let escapeScript = (code) => code.replace(/<(!--|script|\/script)/g, "<\\$1");

let inFile = process.argv[2]
assert(inFile);
let outFile = "/dev/stdout";
if (process.argv[3] == "-o") {
    outFile = process.argv[4];
    assert(outFile);
}

let code = await readFile(inFile, 'utf8');
let html = template.replace(/SCRIPT|TITLE/g,
                            match => (match == "TITLE"
                                      ? inFile.match(/[^/]*$/)[0] :
                                      escapeScript(code)));
await writeFile(outFile, html);
