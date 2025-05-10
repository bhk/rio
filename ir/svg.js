import E from "./e.js";

// https://infra.spec.whatwg.org/#svg-namespace

let ESvg = E.newClass({
    $namespaceURI: "http://www.w3.org/2000/svg",
    $tagName: "svg",
});

let ESvgPath = ESvg.newClass({
    $tagName: "path"
});

// Construct an array of PATH elements from strings (for $d) or ElemProps.
let newPaths = (...paths) =>
    paths.map(p => ESvgPath(typeof p == "string" ? {$d: p} : p));

export {ESvg, ESvgPath, newPaths};
