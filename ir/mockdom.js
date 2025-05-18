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
// WebSocket

import test from "./test.js";
import assert from "assert";

//--------------------------------
// CSS classes
//--------------------------------
//
// See http://www.w3.org/TR/cssom/#the-stylesheet-interface
//

// JavaScript naming of style object property names; include some prefixed names.
let sampleProperties = "color font textAlign float textAlign " +
    "webkitBoxFlex webkitTransform MozFrob msMunge";

class CSSStyleDeclaration extends Array {
    constructor() {
        super();
        // populate with some camel-cased attributes
        for (let name of sampleProperties.split(" ")) {
            this[name] = "";
        }
    }
}

// this includes CSSRule
class CSSStyleRule  {
    constructor(selector, ruleText) {
        assert(ruleText == "");  // that's all we support for now

        // CSSRule
        this.STYLE_RULE = 1;
        this.type = this.STYLE_RULE;
        // Unimpl: cssText, parentRule, parentStyleSheet, various contants

        // CSSStyleRule
        this.selectorText = selector;
        this.style = new CSSStyleDeclaration();
    }
}

class CSSRuleList extends Array { }

class StyleSheet {
    constructor() {
        this.type = "text/css";
        this.href = null;
        this.title = null;
        this.disabled = false;
        // Others: mediaList, ownerNode, parentStyleSheet
    }
}

class CSSStyleSheet extends StyleSheet {
    constructor() {
        super();
        this.cssRules = new CSSRuleList();
        // Others: ownerRule
    }

    insertRule(rule, index) {
        assert(index >= 0 && index <= this.cssRules.length);
        const m = rule.match(/ *(.*?) *\{ *(.*?) *\}/);
        this.cssRules.splice(index, 0, new CSSStyleRule(m[1], m[2]));
        return index;
    }

    deleteRule(index) {
        this.cssRules.splice(index, 1);
    }
}

//--------------------------------
// Node
//--------------------------------

class Node {

    constructor() {
        this._childNodes = [];
        this._listeners = [];
        this._text = "";
    }

    get firstChild() {
        return this._childNodes[0];
    }

    _walk(visit) {
        for (let child of this._childNodes) {
            visit(child);
            if (child instanceof Node) {
                child._walk(visit);
            }
        }
    }

    removeChild(child) {
        const index = this._childNodes.indexOf(child);
        assert(index >= 0);
        this._childNodes.splice(index, 1);
        child.parentNode = null;
    }

    appendChild(child) {
        if (child.parentNode) {
            child.parentNode.removeChild(child);
        }
        child.parentNode = this;
        this._childNodes.push(child);

        return child;
    }

    addEventListener(name, fn, capture) {
        this._listeners.push([name, fn, capture]);
    }

    removeEventListener(name, fn, capture) {
        for (const index in this._listeners) {
            const el = this._listeners[index];
            if (el[0] === name && el[1] === fn && el[2] === capture) {
                this._listeners.splice(index, 1);
                return;
            }
        }
    }

    get textContent() {
        return this._childNodes.map(node => node.textContent).join("");
    }

    set textContent(text) {
        // support use case of removing all child nodes
        //TODO: assert(text === "");
        this._childNodes.splice(0, this._childNodes.length);
        this._text = text;
    }

    get childNodes() {
        return this._childNodes;
    }
}

//--------------------------------
// Element
//--------------------------------

class Element extends Node {
    constructor(tagName, ns) {
        super();
        tagName = tagName.toLowerCase();
        this.tagName = tagName;
        this.namespaceURI = ns;
        this._attrs = new Map();
        this._style = new CSSStyleDeclaration();
    }

    setAttribute(key, value) {
        assert(typeof key == "string");
        assert(typeof value == "string");
        this._attrs.set(key, value);
    }

    removeAttribute(key) {
        assert(typeof key == "string");
        this._attrs.delete(key);
    }

    getAttribute(key) {
        assert(typeof key == "string");
        return (this._attrs.get(key)
                ? this._attrs.get(key)
                : null);
    }

    set className(value) {
        this._attrs.set("class", value);
    }

    get className() {
        return this.getAttribute("class");
    }

    set id(id) {
        this._attrs.set("id", id);
    }

    get id() {
        return this._attrs.get("id") || "";
    }

    set style(value) {
        if (value != "") {
            throw new Error("mockdom: cannot parse STYLE attribute");
        }
    }

    get style() {
        return this._style;
    }

    getBoundingClientRect() {
        // we don't implement layout; return something reasonable
        return {x: 0, y:0, width: 877, height: 780,
                left: 0, top: 0, right: 877, bottom: 780};
    }
}

//--------------------------------
// StyleElement
//--------------------------------

class HTMLStyleElement extends Element {
    constructor() {
        super("style");
        this._styleSheet = new CSSStyleSheet();
    }
}

//--------------------------------
// Text
//--------------------------------

class Text extends Node {
    constructor(text) {
        super();
        this._textContent = String(text);
    }

    get textContent() {
        return this._textContent;
    }

    set textContent(text) {
        this._textContent = text;
    }
}

//--------------------------------
// Document
//--------------------------------

class Document extends Node {
    constructor() {
        super();
        const html = new Element("html");
        this.head = html.appendChild(new Element("head"));
        this.body = html.appendChild(new Element("body"));
        this.appendChild(html);
    }

    createElement(tagName) {
        if (tagName == "style") {
            return new HTMLStyleElement();
        }
        return new Element(tagName);
    }

    createElementNS(ns, tagName) {
        if (tagName == "style") {
            return new HTMLStyleElement();
        }
        return new Element(tagName, ns);
    }

    createTextNode(str) {
        return new Text(str);
    }

    // Create a new getter for the property
    get styleSheets() {
        let sheets = [];
        this._walk(node => {
            if (node instanceof HTMLStyleElement) {
                sheets.push(node._styleSheet);
            }
        });
        return sheets;
    }
}

//--------------------------------
// Mock Event Queue
//--------------------------------

let eventQueue = [];

let postEvent = (target, event) => {
    eventQueue.push({target, event});
};

let dispatchEvents = () => {
    let events = eventQueue;
    eventQueue = [];
    for (let {target, event} of events) {
        target.dispatchEvent(event);
    }
    return events.length > 0;
};

let flushEvents = () => {
    let dispatched = false;
    while (dispatchEvents()) {
        dispatched = true;
    }
    return dispatched;
};

const setTimeout = (fn, delay) => {
    postEvent({dispatchEvent: () => fn()},
              {type: "MockTimer", delay: delay});
};

//--------------------------------
// Event & EventTarget
//--------------------------------

class Event {
    static nextEventID = 0;

    constructor(type, options) {
        this.type = type;
        this.lastEventId = this.nextEventId++;
        this.bubbles = options?.bubbles ?? false;
        this.cancelable = options?.cancelable ?? false;
        this.composed = options?.composed ?? false;
    }
}

class MessageEvent extends Event {
    constructor(type, options) {
        super(type, options);
        this.data = options?.data ?? null;
    }
}

class EventTarget {
    dispatchEvent(evt) {
        let name = evt.type;
        let handler = this["on" + name];
        if (handler) {
            evt.target = this;
            evt.currentTarget = this;
            //console.log(`EventTarget: dispatch ${name} ${evt.data || ""}`);
            handler(evt);
            //console.log(`EventTarget: done`);
        } else {
            (this._dropped || (this._dropped = [])).push(evt);
            //console.log(`EventTarget: drop ${name} ${evt.data || ""}`);
        }
    }
}

//--------------------------------
// WebSocket
//--------------------------------

class WebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, protocol) {
        super();
        this.readyState = WebSocket.CONNECTING;
        this.bufferedAmount = 0;
        this.url = url;
        this.protocol = protocol || 'ws';
        this.readyState = 0;
        this._peer = null;
    }

    close() {
        this.readyState = WebSocket.CLOSED;
        this._peer = null;
    }

    send(msg) {
        assert(this.readyState == WebSocket.OPEN);
        assert(typeof msg == "string");
        postEvent(this._peer, new MessageEvent("message", {data: msg}));
    }

    _connect(ws) {
        this._peer = ws;
        this.readyState = WebSocket.OPEN;
        postEvent(this, new Event("open"));
    }
}

let connect = (ws1, ws2) => {
    ws1._connect(ws2);
    ws2._connect(ws1);
};

//--------------------------------
// Browser Globals
//--------------------------------

// Assign Node globals to enable testing of modules that assume the browser
// environment (as long as they are loaded after this module).

let G = global;

G.window = global;
G.document = new Document();
G.Node = Node;
G.Element = Element;
G.Event = Event;
G.MessageEvent = MessageEvent;
G.EventTarget = EventTarget;
G.WebSocket = WebSocket;
G.setTimeout = setTimeout;

export {
    connect,
    eventQueue,
    postEvent,
    dispatchEvents,
    flushEvents,
}

//--------------------------------
// quick self-test
//--------------------------------

if (test) {
    let {eq} = test;

    const d = new Document();
    const styleElem = d.createElement("style");
    d.head.appendChild(styleElem);
    const sheet = d.styleSheets[d.styleSheets.length - 1];

    assert(sheet.cssRules instanceof Array);

    eq(0, sheet.insertRule("p {}", 0));
    const r = sheet.cssRules[0];

    eq(r.selectorText, "p");

    // test WebSocket & events
    let ws1 = new WebSocket();
    let ws2 = new WebSocket();
    let out1 = [];
    let out2 = [];
    eq(ws1.readyState, WebSocket.CONNECTING);
    ws1.onmessage = (evt) => out1.push(evt.data);
    ws2.onmessage = (evt) => out2.push(evt.data);

    connect(ws1, ws2);
    ws1.send("hi");
    flushEvents();
    eq(out2, ["hi"]);
}

// Load target module if given (for off-target tests of browser code).
const m = window?.process?.env?.DOMIMPORT;
m && import(m);
