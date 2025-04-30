// initialize browser globals & minimal DOM API support

import "./mockdom.js";
import test from "./test.js";
import {use, lazy, state, cell} from  "./i.js";
import E from "./e.js";

const {eq, assert} = test;

// ASSERT: e.js creates a style sheet for its use

const sheet = document.styleSheets[0];
assert(sheet);


// E.newClass : derive new E

const testSet = cell(() => {
    // E(...)

    let e = E();
    eq(e.tagName, "div");
    eq(e.className, "");
    eq(0, e.childNodes.length);

    e = E({$tag: "i"});
    eq(e.tagName, "i");
    eq(e.className, "");
    eq(0, e.childNodes.length);

    e = E({}, "x");
    eq(e.tagName, "div");
    eq(e.className, "");
    eq(1, e.childNodes.length);

    // Derive factory

    const Foo = E.newClass({
        $name: "foo",
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
        $tag: "span",
    }, "abc", null, "def");
    eq(e.tagName, "span");
    eq(e.className, "foo");
    eq(2, e.childNodes.length);

    // Instantiate with $tag, $attrs, properties, and content

    e = Foo({
        $tag: "span",
        width: 2,
        $attrs: {
            id: "x",
        },
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

let icontent = state(["V"]);
let icolor = state("black");
let ifont = state("sans-serif");
let ialt = state("ALT1");
let iclass = state("up");
let ix = state(0);
let baseFn = _ => {
    // Create a new factory and instantiate it
    const CT = E.newClass({
        $name: "CT",
        color: icolor,
    });

    use(ix);
    return CT({
        font: ifont,
        $attrs: {
            alt: ialt,
            class: iclass,
        },
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
ialt.set("ALT2");
iclass.set(null);
let e2 = use(base);
// Assert: element persists, but content & property have changed
assert(e1 === e2);
eq(e2.textContent, "a<>b");
eq(e2.style.font, "mono");
eq(e1.getAttribute("class"), "CT ");
eq(e1.getAttribute("alt"), "ALT2");
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

// Drop base

// Assert: no leakage of resources
base.deactivate();
eq(sheet.cssRules.length, 0);
