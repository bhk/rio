// initialize browser globals & minimal DOM API support

import "./mockdom.js";
import test from "./test.js";
import {use, lazy, state, cell} from  "./i.js";
import { default as Edefault, Div, assign } from "./e.js";

const {eq, assert} = test;

// ASSERT: e.js creates a style sheet for its use

const sheet = document.styleSheets[0];
assert(sheet);

// ASSERT: correct default

assert(Edefault === Div);
const E = Div;

// E.newClass : derive new E

const testSet = cell(() => {
    // E(...)

    let e = E();
    eq(e.tagName, "div");
    eq(e.className, null);
    eq(0, e.childNodes.length);

    e = E({$tagName: "i"});
    eq(e.tagName, "i");
    eq(e.className, null);
    eq(0, e.childNodes.length);

    e = E({}, "x");
    eq(e.tagName, "div");
    eq(e.className, null);
    eq(1, e.childNodes.length);

    // Derive factory

    const Foo = E.newClass({
        $class: "foo",
        color: "black",
        transform: "#{transform} #{color}",

        "&:hover": {
            color: "blue"
        },

        "&.enabled": {
            color: "red"
        }
    });

    eq(sheet.cssRules.length, 3);
    eq(sheet.cssRules[0].selectorText, ".foo");
    eq(sheet.cssRules[1].selectorText, ".foo.enabled");
    eq(sheet.cssRules[2].selectorText, ".foo:hover");

    eq(sheet.cssRules[0].style.color, "black");
    eq(sheet.cssRules[1].style.color, "red");
    eq(sheet.cssRules[0].style["-webkit-transform"], "-webkit-transform color");

    // derive from derived factory

    const Bar = Foo.newClass({
        color: "blue",
    });
    eq(sheet.cssRules.length, 4);

    // Instantiate derived factory

    e = Foo({
        $tagName: "span",
    }, "abc", null, "def");
    eq(e.tagName, "span");
    eq(e.className, "foo");
    eq(2, e.childNodes.length);

    // Instantiate with $tagName, $ATTR, properties, and content

    e = Foo({
        $tagName: "span",
        $id: "x",
        width: 2,
        color: "black",
    }, "abc", "def");
    eq(e.tagName, "span");
    eq(e.className, "foo");
    eq(e.id, "x");
    eq(2, e.childNodes.length);
    eq("2px", e.style.width);
    eq("black", e.style.color);

    return true;
});

eq(use(testSet), true);
testSet.deactivate();

// ASSERT: resources are freed on drop
eq(sheet.cssRules.length, 0);

// Test reactivity
//
// We create a root cell that constructs a factory and uses it to create an
// element.  State variables for element content, an element property, and a
// style property should be able to change while the resulting element
// persists.  A state variable read by the root cell itself will cause the
// element to be destroyed and re-created.

let icontent = state(["V"]);      // content
let icolor = state("black");      // CSS property
let ifont = state("sans-serif");  // CSS property
let ialt = state("ALT1");         // attribute
let iclass = state("up");         // special attribute
let ix = state(0);                // invalidates constructing cell
let baseFn = _ => {
    // Create a new factory and instantiate it
    const CT = E.newClass({
        $class: "CT",
        color: icolor,
    });

    use(ix);
    return CT({
        $classList: iclass,
        $alt: ialt,
        font: ifont,
    }, ["a", icontent, "b"]);
};
let base = cell(baseFn);

// Cycle 1

let e1 = use(base);
eq(e1.childNodes.length, 3);
eq(e1.textContent, "aVb");
eq(e1.style.font, "sans-serif");
eq(e1.getAttribute("class"), "CT up");
eq(e1.getAttribute("alt"), "ALT1");
eq(sheet.cssRules.length, 1);
eq(sheet.cssRules[0].selectorText, ".CT");
eq(sheet.cssRules[0].style.color, "black");

// Cycle 2: Change values

icontent.set(["<", ">"]);
icolor.set("red");
ifont.set("mono");
ialt.set(false);
iclass.set(null);
let e2 = use(base);
// Assert: element persists, but content & property have changed
assert(e1 === e2);
eq(e2.textContent, "a<>b");
eq(e2.style.font, "mono");
eq(e1.getAttribute("class"), "CT ");
// Assert: Attribute removed when value == false
eq(e1.getAttribute("alt"), null);
// Assert: factory class persists, but property has been updated
eq(sheet.cssRules[0].selectorText, ".CT");
eq(sheet.cssRules[0].style.color, "red");

// Cycle 3: Invalidate base cell

ix.set(1);
let e3 = use(base);
assert(e3 !== e2);
eq(e3.textContent, "a<>b");
// Assert: invalidated base's resources were dropped
eq(sheet.cssRules[0].selectorText, ".CT");

// assign

let tc = cell(_ => {
    let elem = document.createElement("div");
    elem.appendChild(document.createElement("i"));
    eq(1, elem.childNodes.length);

    // ASSERT: attributes are applied
    // ASSERT: content is replaced
    assign(elem, {$value: "V"}, "Hi");
    eq("V", elem.getAttribute("value"));
    eq("Hi", elem.firstChild.textContent);
    eq(1, elem.childNodes.length);

    // ASSERT: when no content arguments are provided, content is left unchanged
    assign(elem, {$value: "X"});
    eq("X", elem.getAttribute("value"));
    eq("Hi", elem.firstChild.textContent);
});
use(tc);
tc.deactivate();

// Drop base

// Assert: no leakage of resources
base.deactivate();
eq(sheet.cssRules.length, 0);
