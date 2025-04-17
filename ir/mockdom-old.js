// A minimal set of mock DOM APIs for testing.
//
// window
// document :: Node
// document.head
// document.body
// document.createElement
// document.createTextNode
// document.styleSheets
// <Node>.childNodes
// <Node>.appendChild
// <Node>.removeChild
// <Node>.textContent
// <Node>.addEventListener
// <Node>.removeEventListener
// <StyleSheet>.addRule
// <StyleRule>.selectorText
// <StyleRule>.style
// <Style>.<propertyName>

const Class = require("class.js");
const expect = require("expect.js");

const assert = expect.assert;


function walk(node, fn) {
    function visit(node) {
        node.childNodes.forEach(function (child) {
            fn(child);
            if (child.childNodes) {
                visit(child);
            }
        });
    }
    visit(node);
}


//--------------------------------

const CSS2Properties = Class.subclass();


// JavaScript naming of style object property names; include some prefixed names.
const sampleProperties = "color font textAlign cssFloat textAlign webkitBoxFlex webkitTransform MozFrob msMunge";

sampleProperties.match(/[^ ]+/g).forEach(function (name) {
    CSS2Properties[name] = "";
});


//--------------------------------

const StyleRule = Class.subclass();

const CSSStyleRule = StyleRule.subclass();

CSSStyleRule.initialize = function (sel, text) {
    assert(text == "");

    this.style = CSS2Properties.create();
    this.selectorText = sel;
};


//--------------------------------
// See http://www.w3.org/TR/cssom/#the-stylesheet-interface

const StyleSheet = Class.subclass();


const CSSStyleSheet = StyleSheet.subclass();


CSSStyleSheet.initialize = function () {
    this.cssRules = [];
    this.disabled = false;
};


CSSStyleSheet.insertRule = function (rule, index) {
    assert(index >= 0 && index <= this.cssRules.length);

    const m = rule.match(/ *(.*?) *\{ *(.*?) *\}/);
    this.cssRules.splice(index, 0, CSSStyleRule.create(m[1], m[2]));
    return index;
}


CSSStyleSheet.deleteRule = function (index) {
    this.cssRules.splice(index, 1);
}



//--------------------------------

const Node = Class.subclass();

Node.initialize = function () {
    this.childNodes = [];
    this.listeners = [];
};


Object.defineProperty(Node, "firstChild", {
    get: function () {
        return this.childNodes[0];
    },
});


Node.removeChild = function (child) {
    const index = this.childNodes.indexOf(child);
    assert(index >= 0);
    this.childNodes.splice(index, 1);
    child.parentNode = null;
};


Node.appendChild = function (child) {
    if (child.parentNode) {
        child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);

    return child;
};


Node.addEventListener = function (name, fn, capture) {
    this.listeners.push([name, fn, capture]);
};


Node.removeEventListener = function (name, fn, capture) {
    for (const index in this.listeners) {
        const el = this.listeners[index];
        if (el[0] === name && el[1] === fn && el[2] === capture) {
            this.listeners.splice(index, 1);
            return;
        }
    }
};


Object.defineProperty(Node, "textContent", {
    get: function () {
        const text = "";
        walk(this, function visit(node) {
            if (node.$text) {
                text += node.$text;
            }
        });
        return text;
    },
    set: function (text) {
        assert(text === "");
        this.childNodes.splice(0, this.childNodes.length);
    }
});


//--------------------------------

const Element = Node.subclass();

Element.initialize = function (tagName) {
    Node.initialize.call(this);
    this.tagName = tagName;
    this.className = "";
    this.attrs = new Map();

    if (tagName == "style") {
        this.$sheet = CSSStyleSheet.create();
    }

    this.style = CSS2Properties.create();
};


Element.setAttribute = function (key, value) {
    assert(typeof key == "string");
    assert(typeof value == "string");
    this.attrs.set(key, value);
    if (key === "class") {
        this.className = value;
    } else if (key === "style" && value != "") {
        throw new Error("dom_emu: cannot parse STYLE attribute.");
    }
}



//--------------------------------

const Text = Node.subclass();


Text.initialize = function (str) {
    Node.initialize.call(this);
    this.$text = String(str);
};

Object.defineProperty(Text, "textContent", {
    get: function () {
        return this.$text;
    },
    set: function (text) {
        this.$text = text;
    }
});


//--------------------------------

const Document = Node.subclass();

Document.initialize = function () {
    Node.initialize.call(this);

    const html = Element.create("html");
    this.appendChild(html);

    this.head = html.appendChild(Element.create("head"));
    this.body = html.appendChild(Element.create("body"));
};


Object.defineProperty(Document, "textContent", {
    value: null
});


Document.createElement = function (tagName) {
    return Element.create(tagName);
};


Document.createTextNode = function (str) {
    return Text.create(str);
};


Object.defineProperty(Document, "styleSheets", {
    // Create a new getter for the property
    get: function () {
        const sheets = [];
        walk(this, function visit(node) {
            if (node.$sheet) {
                sheets.push(node.$sheet);
            }
        });
        return sheets;
    }
});


//--------------------------------
// Browser globals
//--------------------------------

global.window = global.window || global;
global.document = Document.create();

// so "instanceof" will work...
window.Node = Node.constructor;
window.Element = Element.constructor;


//--------------------------------
// quick self-test

const d = Document.create();
const styleElem = d.createElement("style");
d.head.appendChild(styleElem);
const sheet = d.styleSheets[d.styleSheets.length - 1];

assert(sheet.cssRules instanceof Array);

expect.eq(0, sheet.insertRule("p {}", 0));
const r = sheet.cssRules[0];

expect.eq(r.selectorText, "p");
