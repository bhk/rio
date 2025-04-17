// E: DOM Element Factory
//
// Overview
//
//   E : (EProps, ...Content) -> DOMElement
//   E.newClass : EProps -> E
//
// Content is one of the following:
//
//    - `null`, `undefined`, or "" (these are ignored)
//    - DOM Node
//    - string
//    - Array of Content
//
// EProps
//
//    EProps objects describe element properties and attributes.  Each entry
//    is one of the following:
//
//     - A CSS declaration        color: "black"
//     - A sub-rule               "&:hover": { color: "blue" }
//     - A non-CSS definition     $tag: "br"
//
//    Any key that does not begin with `$` and does not contain `&` is
//    treated as a CSS property name written in camel-case form.  These will
//    be normalized to a potentially browser-specific prefixed form (see
//    `cssName`).  The corresponding value can be a string or a number
//    (denoting a size in pixels); other values are treated as an empty
//    string.  Any occurrences of "#{NAME}" will be replaced with
//    cssName(NAME).
//
//    The key of a sub-rule is a CSS selector in which "&" represents the
//    current element.  Its value is an object that may contain CSS
//    declarations or nested sub-rules to be applied when the selector
//    matches the current element.  For example, this will set the element's
//    color to red when it follows an <h2> element:
//
//        { "h2 + &": { color: "red" } }
//
//    Non-CSS definitions include the following (key -> value):
//
//      `$tag` -> an element type (tag) name
//
//      `$ns` -> an XML namespace, or `null` for the default (HTML).
//
//      `$name` -> a string to be incorporated into the factory-assigned
//          class name (for debugging purposes).
//
//      `$attrs` -> an object that maps element attribute names to strings.
//          [Note: the `class` attribute is handled specially: names in the
//          user-provided value will be *included* in the element's class,
//          but will not override the factory-assigned name.]
//
//      `$events` -> an object that maps event names to handlers.
//
// Reactivity
//
//    Content, CSS property values, and element attribute values may be
//    provided as thunks, in which case the caller will be isolated from
//    their changes.  These values are evaluated in a separate cell without
//    affecting the value returned from E() or E.newClass().
//
//    Any change to one or more content values will result in re-parenting
//    of all child DOM nodes. [TBO]
//
// E(PROPS, ...CONTENT)
//
//    Create an element with specified properties and content.  Note:
//    Element factories (like E) are functions *and* objects.
//
//    If PROPS contains a property named `$element`, then no element will be
//    created and instead the property value provides a DOM element to which
//    the rest of PROPS will be applied.  If one or more CONTENT arguments
//    are given, then all children in the element will be *replaced*;
//    otherwise existing children will be laft intact.  This call is purely
//    for side effects, and is for use by imperative root-cell code.
//
// E.newClass(PROPS)
//
//    Create a factory (compatible with E) that creates elements that
//    inherit definitions from PROPS.  PROPS will override any definitions
//    already associated with the element factory.  In the case of
//    object-valued entries (e.g. $attrs), the object will not override; the
//    definitions within the object will individually override.
//
//    A CSS class will is dynamically created to convey CSS properties in
//    PROPS by adding declarations to `document.styleSheets`.  For example,
//    E.newClass(A).newClass(B)(E) creates an element that inherits CSS
//    properties from A and B based on its class attribute. Properties from
//    E are applied to the element directly via its style object.
//
//    Non-CSS parts of EProps (attributes, tag name, ...) are always applied
//    to the element directly.
//

import {activate, use, isThunk, onDrop, softApply} from "./i.js";
import test from "./test.js";

const D = document;
const newElement = (tagName, ns) =>
      ns ? D.createElementNS(ns, tagName) : D.createElement(tagName);

//------------------------------------------------------------------------
// Normalize CSS property names
//------------------------------------------------------------------------

let throwError = (arg) => {
    throw Error(arg);
};

// Memoize a function that accepts a single string argument
//
let memoize = (fn) => {
    const cache = new Map();
    return (arg) => {
        if (cache.has(arg)) {
            return cache.get(arg);
        }
        const result = fn(arg);
        cache.set(arg, result);
        return result;
    }
};

// Create style object for detecting browser-specific prefixing
//
const styleObject = newElement("div").style;

const prefixes = [null, "webkit", "Moz", "ms", "css"];

// Auto-detect support for a (JS camel-case) CSS property name, trying
// alternative browser-specific prefixes until a supported one is found.
//
const tryPrefixes = (name) => {
    for (const prefix of prefixes) {
        const prop = (prefix
                      ? prefix + name[0].toUpperCase() + name.substr(1)
                      : name);
        // Yes, the "in" operator includes properties like "toString", but
        // presumably any actual property must avoid these conflicts.
        if (prop in styleObject) {
            return prop;
        }
    }
    return name;
};

// Convert a generic JavaScript style property name (camel case) to a CSS
// property name recognized by the current browser.  The resulting form is
// what needs to appear within CSS property values (like `transition`).
//
// E.g.  "boxSizing" -> "-moz-box-sizing"  [somewhere, sometime]
//
let cssName = (name) =>
    tryPrefixes(name)
    .replace(/([A-Z])/g, "-$1").toLowerCase()
    .replace(/^(webkit|ms)/, "-$1");

cssName = memoize(cssName);

// Convert JavaScript values to strings suitable for CSS.  Converts numbers
// to dimensionts in "px" units.  Within strings, replace "#{NAME}" with
// cssName("NAME").
//
const cssValue = (value) =>
      typeof value == "string" ? value.replace(/#\{(.*?)\}/g,
                                               (_, name) => cssName(name))
      : typeof value == "number" ? value + "px"
      : "";

if (test) {
    let {eq} = test;

    eq("float", cssName("float"));
    eq("-webkit-box-flex", cssName("boxFlex"));

    eq("2px", cssValue(2));
    eq("float -webkit-transform -moz-bar -ms-baz",
       cssValue("#{float} #{transform} #{MozBar} #{msBaz}"));
}

//------------------------------------------------------------------------
// Construct non-conflicting class names
//------------------------------------------------------------------------

const allNames = new Set();
let nextNum = 1;

// Return a name different from all previous results
//
const getUniqueName = (name) => {
    while (allNames.has(name)) {
        // append or replace trailing number with a new one
        const m = name.match(/(.*?)(\d*)$/);
        name = m[1] + nextNum++;
    }
    allNames.add(name);
    onDrop(_ => allNames.delete(name));
    return name;
};

//------------------------------------------------------------------------
// Dynamic style sheet manipulation
//------------------------------------------------------------------------

// Add a new stylesheet to hold our generated CSS rules
D.head.appendChild(newElement("style"));
const styleSheet = D.styleSheets[D.styleSheets.length - 1];

// Dynamically create an empty style sheet rule, and return the style
// object.
//
const insertRule = (selector) => {
    styleSheet.insertRule(selector + " {}", 0);
    return styleSheet.cssRules[0];
};

// Remove rules matching selectors.
//
const deleteRules = (selectorSet) => {
    let rule;
    for (let i = 0; (rule = styleSheet.cssRules[i]) != null; ++i) {
        if (selectorSet.has(rule.selectorText)) {
            styleSheet.deleteRule(i);
            --i;
        }
    }
};

// Assign an individual property to a style object.
//
const setStyleProperty = (style, name, value) => {
    if (isThunk(value)) {
        activate(_ => setStyleProperty(style, name, use(value)));
    } else {
        name = cssName(name);
        style[name] = cssValue(value);
    }
};

// Apply declarations in `decls` to style object `style`
//
const setStyleProperties = (style, decls) => {
    if (decls) {
        for (let key in decls) {
            setStyleProperty(style, key, decls[key])
        }
    }
};

// Replace "&" wildcard in pattern with `context`
//
const expandSelector = (pattern, context) =>
      pattern ? pattern.replace(/\&/g, context) : context;

// Create and add a stylesheet rule for each member of rules[].
//
let defineRules = (rules, context) => {
    const added = new Set();
    for (const {selector, decls} of rules || []) {
        let ruleSelector = expandSelector(selector, context);
        added.add(ruleSelector);
        const style = insertRule(ruleSelector).style;
        setStyleProperties(style, decls);
    }
    onDrop(_ => deleteRules(added));
};

//------------------------------------------------------------------------
// DOM Node manipulation & ElemFactory
//------------------------------------------------------------------------

let setListener = (elem, name, fn) => {
    elem.addEventListener(name, fn);
};

let setListeners = (e, o) => {
    for (let name in o) {
        setListener(e, name, o[name]);
    }
};

// Set attribute `name` to `value`.  Do not assume values have not already
// been set on the element; this can be re-evaluted in an activated cell.
//
let setAttr = (e, name, value) => {
    if (isThunk(value)) {
        activate(_ => setAttr(e, name, use(value)));
    } else if (typeof value == "function") {
        throw Error("bad attribute");
    } else {
        // HTML attributes are case-insensitive, but SVG is case-sensitive,
        // so we cannot convert camelCase to dashed-words.  Ironically, SVG
        // also uses dash-delimited attribute names, and is the main case in
        // which we would have liked to use camelCase as shorthand.
        e.setAttribute(name, String(value));
    }
};

let setAttrs = (e, attrs, autoClass) => {
    for (let key in attrs) {
        if (key == "class") {
            let a = autoClass;
            let prefix = b => a + " " + (b || "");
            autoClass = softApply(prefix, attrs[key]);
        } else {
            setAttr(e, key, attrs[key]);
        }
    }
    if (autoClass) {
        setAttr(e, "class", autoClass);
    }
};

let badNodes = [];

let badNodeText = (value) => {
    // window.BADNODES = badNodes;   // expose for debugging
    badNodes.push(value);
    return D.createTextNode("<BADNODE[" + (badNodes.length - 1) + "]>");
};

let prepareNode = (node) =>
    (node instanceof Node
     ? node
     : D.createTextNode(typeof node == "string" ? node : badNodeText(node)));

// Replace content of element `e` with `content` (a string, DOM element, or
// array of strings/elements).
//
let setContent = (e, content) => {
    // Remove existing content
    while (e.firstChild) {
        e.removeChild(e.firstChild);
    }

    let appendContent = child => {
        // Allow "holes" in the content array
        child = use(child);
        if (child instanceof Array) {
            child.forEach(appendContent);
        } else if (child != null && child !== "") {
            e.appendChild(prepareNode(child));
        }
    };

    appendContent(content);
};

// Assign element
let setElem = (e, rules, selector, attrs, events) => {
    if (rules[0]) {
        // Depth-first traversal of subrules => they appear first
        if (rules[0].selector) {
            // Selector patterns require a stylesheet rule.  When present we
            // entirely avoid `e.style` so that sub-rules override other
            // properties.  E.g. {color:X} vs. {"&:hover":{color:Y}}
            if (!attrs.id) {
                attrs = {...attrs, id: getUniqueName("I0")};
            }
            defineRules(rules, "#" + attrs.id);
        } else {
            test && test.assert(rules.length == 1);
            // In the simple case we do not need a stylesheet rule.
            setStyleProperties(e.style, rules[0].decls);
        }
    }
    setAttrs(e, attrs, selector.replace(/\./g, " ").substr(1));
    setListeners(e, events || []);
    return e;
};

//----------------------------------------------------------------
// E: Element Factory
//----------------------------------------------------------------

// FactoryState objects are internal values that store information needed by
// an Element Factory.
//
//   tag      = DOM element tag name
//   ns       = null, or XML namespace
//   events   = object: event name -> function
//   name     = base for class name generation
//   attrs    = object: attributeName -> string
//   selector = a selector used to identify elements created from the EF
//              instance, such as ".C0.C1".  The selector includes class
//              names of each parent EF in order to increase the specificity
//              of the resulting rule.
//

let rootFactoryState = {
    tag: "div",
    ns: null,
    attrs: {},
    selector: "",
    name: "E0",
};

// Separate an EProps into its non-CSS and CSS parts.
// (esIn, props) -> [esOut, rules]
//
//   esIn: FactoryState
//   props: EProps
//   esOut: an FactoryState to which the non-CSS properties have been applied
//   rules: CSS rules that apply CSS properties from `props`
//          Note: CSS rule = selector + declaration block (object, here)
//
let splitProps = (esIn, propsIn) => {
    if (propsIn == null) {
        return [esIn, []];
    }
    if (typeof propsIn != "object") {
        throw new Error("Bad `props` value");
    }

    let es = {...esIn};
    let rules = [];

    let split = (props, selector) => {
        let decls;

        for (let key in props) {
            let value = props[key];
            if (key[0] == "$") {
                // non-CSS property
                if (selector) {
                    throw new Error("Non-CSS option inside pattern rule: "
                                    + selector + " {" + key + ": ...}")
                } else if (key == "$tag") {
                    es.tag = value;
                } else if (key == "$ns") {
                    es.ns = value;
                } else if (key == "$element") {
                    // ignore
                } else if (key == "$events") {
                    es.events = {...es.events, ...value};
                } else if (key == "$name") {
                    es.name = value;
                } else if (key == "$attrs") {
                    es.attrs = {...es.attrs, ...value};
                } else {
                    throw new Error("Bad prop: " + key);
                }
            } else if (/\?/.test(key)) {
                throw new Error("Bad prop: " + key);
            } else if (/\&/.test(key)) {
                // selector pattern
                split(value, expandSelector(key, selector || "&"));
            } else {
                decls = decls || {};
                decls[key] = value;
            }
        }
        if (decls) {
            rules.push({selector, decls});
        }
    };
    split(propsIn, null);

    return [es, rules];
};

if (test) {
    let [es, rules] = splitProps(rootFactoryState, {x: 1, "&.c":{y:2}});
    test.eq(rules.length, 2);
    test.eq(rules[0].selector, "&.c");
    test.eq(rules[1].selector, null);
}

// Create a DOM element
//
let createElem = (fstIn, props, content) => {
    let [fst, rules] = splitProps(fstIn, props);
    let e = (props && props.$element) || newElement(fst.tag, fst.ns);
    setElem(e, rules, fst.selector, fst.attrs, fst.events);
    if (content[0]) {
        // TBO: don't create cell when values are already computed
        // TBO: don't reparent all children on update
        activate(_ => setContent(e, content));
    }
    return e;
};

// Create a derived FactoryState
//
let newFactoryState = (fstIn, props) => {
    let [fst, rules] = splitProps(fstIn, props);
    if (rules.length > 0) {
        fst.selector = fst.selector + "." + getUniqueName(fst.name);
        defineRules(rules, fst.selector);
    }
    return fst;
};

// Construct a new factory function/object.
//
let newFactory = (fst) => {
    let f = (props, ...content) => createElem(fst, props, content);
    f.newClass = (props) => newFactory(newFactoryState(fst, props));
    return f;
};

let E = newFactory(rootFactoryState);

export default E;
