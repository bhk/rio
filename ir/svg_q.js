import test from "./test.js";
import "./mockdom.js";
import { ESvgPath, newPaths } from "./svg.js";

const { eq, assert } = test;

let p = ESvgPath({$d: "M1,2 l4,5 z"});
eq(p.tagName, "path");
eq(p.namespaceURI, "http://www.w3.org/2000/svg");
eq(p.getAttribute("d"), "M1,2 l4,5 z");

eq( [p, ...newPaths({$d: "TEST"})],
    newPaths({$d: "M1,2 l4,5 z"}, "TEST") );
