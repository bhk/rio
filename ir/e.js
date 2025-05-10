// E: DOM Element Factory
//
// ## Overview
//
// Div : an element factory, which can be used to construct DOM elements or
//    derived element factories.  Element factories are functions and
//    objects.  The interface is described below, wherein "E" is an element
//    factory:
//
//    E(EProps, ...Content) : Create an element with specified properties
//        and content.  Note: Element factories (like E) are functions *and*
//        objects.
//
//    E.newClass(PROPS) : Create a factory (compatible with E) that creates
//        elements that inherit definitions from PROPS.  PROPS will override
//        any definitions already associated with the element factory.
//
// assign(DOMElement, EProps, ...Content)
//
//    Assign attributes, properties, and content to an existing element.  If
//    one or more content arguments are given, then all children in the
//    element will be *replaced*; otherwise existing children will be left
//    intact.  This call is purely for side effects, and is for use by
//    imperative root-cell code.
//
// ## Details
//
// Content is one of the following:
//
//    - `null`, `undefined`, or "" (these are ignored)
//    - DOM Node
//    - Array of Content
//    - string
//    - other (converted to string)
//
// EProps
//
//    EProps objects describe element properties and attributes.  Each entry
//    is one of the following:
//
//     - Attribute definition       $value: "OK"
//     - CSS property declaration   color: "black"
//     - CSS sub-rule               "&:hover": { color: "blue" }
//
//    Keys beginning with `$` define element attributes or one of a small
//    number pseudo-attributes (described below).  Characters following the
//    `$` provide the attribute name.  Attribute values will be converted to
//    strings, except for event handlers (described below) and false, null,
//    or undefined, which specify that the attribute will be absent from the
//    element.
//
//    If the key does not begin with `$` and does not contain `&`, the entry
//    is a CSS property declaration.  CSS property names are written in
//    camel-case form; the library translates them to potentially
//    browser-specific prefixed forms as necessary (see the `cssName`
//    implementation).  CSS property values can be strings or numbers
//    (denoting a size in pixels); other values are treated as an empty
//    string.  Any occurrences of "#{NAME}" will be replaced with
//    cssName(NAME).
//
//    Keys containing `&` describe the *selector* of a CSS sub-rule in which
//    `&` represents the current element.  The entry's value is an object
//    containing CSS declarations that will apply to elements that are
//    matched by the selector.  The object may also contain nested
//    sub-rules. For example, this will set the element's color to red when
//    it follows an <h2> element: `"h2 + &": { color: "red" }`.
//
//    Pseudo-attribute keys:
//
//      `$tagName`: element type to be used to create the element
//
//      `$namespaceURI`: an XML namespace used to create the element;
//         `null` for the default (HTML).
//
//    The following attribute keys are handled specially:
//
//      `$class`: a suggested class name.  The actual class attribute will
//         incorporate a class name used for styling (based on this value,
//         perhaps with additional text to guarantee uniqueness), names from
//         inherited classes, and names listed in `classList`.
//
//      `$classList`: a list of names to be included verbatim in the actual
//         class attribute.  Any dynamic class names should be specified
//         here, not in `$class`.
//
//      `$on...`: Keys named `$on<EVENT>` define event handlers that will be
//         installed using setListener(), not setAttribute().  The
//         corresponding value must be a function.
//
// Reactivity
//
//    Content, CSS property values, and attribute values may be provided as
//    thunks, in which case the caller will be isolated from their changes.
//    These values are evaluated in a separate cell without affecting the
//    value returned from E() or E.newClass().
//
//    Any change to one or more content values will result in re-parenting
//    of all child DOM nodes. [TBO]
//
// Implementation Notes
//
//    CSS classes are dynamically created to convey CSS properties for
//    element factories and added to `document.styleSheets`.  For example,
//    E.newClass(A).newClass(B)(C) creates an element that inherits CSS
//    properties from A and B based its class attribute. Properties from C
//    are applied to the element directly via its style object.
//

import { use, cell, isThunk, onDrop, lazyApply } from "./i.js";
import test from "./test.js";

const D = document;
const newElement = (tag, ns) =>
      ns ? D.createElementNS(ns, tag) : D.createElement(tag);

//------------------------------------------------------------------------
// Normalize CSS property names
//------------------------------------------------------------------------

// Memoize a function that accepts a single argument
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
// to dimensions in "px" units.  Within strings, replace "#{NAME}" with
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
        use(cell(_ => setStyleProperty(style, name, use(value))));
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

// Replace "&" wildcard in selector with `context` (which matches the
// current element/class).  A null selector => match this element/class.
//
const expandSelector = (selector, context) =>
      selector ? selector.replace(/\&/g, context) : context;

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
// DOM Node manipulation
//------------------------------------------------------------------------

// rootEPA defines defaults for ElemProp attributes. These happen to be
// pseudo-attributes.  Each element factory accumulates these *and* actual
// attributes into derived "EPA" objects.
//
// `selector` includes class names of each parent ElemFactory in order to
// increase the specificity of the resulting rule.
//
let rootEPA = {
    selector: "",
    $tagName: "div",
    $namespaceURI: null,
    $class: "E0",  // default class name
};

// Set attribute `name` to `value`.  Do not assume values have not already
// been set on the element; this can be re-evaluated in an activated cell.
//
// SVG attributes are case-sensitive, so we cannot convert camelCase to
// dashed-words.  Ironically, SVG also uses dash-delimited attribute names,
// so it is the main reason we would have liked to support camelCase.
//
let setAttr = (e, name, value) => {
    if (isThunk(value)) {
        use(cell(_ => setAttr(e, name, use(value))));
    } else if (name[0] == 'o' && name[1] == 'n') {
        e.addEventListener(name.slice(2), value);
    } else if (typeof value == "function") {
        throw Error("bad attribute");
    } else if (value === false || value == null) {
        e.removeAttribute(name);
    } else {
        e.setAttribute(name, String(value));
    }
};

let setEPA = (e, eprops, autoClass) => {
    for (let key in eprops) {
        if (key == "$classList") {
            let a = autoClass;
            let prefix = b => a + " " + (b || "");
            autoClass = lazyApply(prefix, eprops[key]);
        } else if (!(key in rootEPA)) {
            setAttr(e, key.slice(1), eprops[key]);
        }
    }
    if (autoClass) {
        setAttr(e, "class", autoClass);
    }
};

// Replace content of element `e` with `content` (a string, DOM element, or
// array of strings/elements).
//
let setContent = (e, content) => {
    // Remove existing content
    while (e.firstChild) {
        e.removeChild(e.firstChild);
    }

    let appendContent = child => {
        child = use(child);
        if (Array.isArray(child)) {
            for (const item of child) {
                appendContent(item);
            }
        } else if (child != null && child !== "") {
            e.appendChild((child instanceof Node
                           ? child
                           : D.createTextNode(String(child))));
        }
    };

    appendContent(content);
};

// Assign element
let setElem = (e, epa, rules) => {
    if (rules[0]) {
        // Depth-first traversal of subrules => they appear first
        if (rules[0].selector) {
            // Selector patterns require a stylesheet rule.  When present we
            // entirely avoid `e.style` so that sub-rules override other
            // properties.  E.g. {color:X} vs. {"&:hover":{color:Y}}
            if (!epa.$id) {
                epa = {...epa, $id: getUniqueName("I0")};
            }
            defineRules(rules, "#" + epa.$id);
        } else {
            test && test.assert(rules.length == 1);
            // In the simple case we do not need a stylesheet rule.
            setStyleProperties(e.style, rules[0].decls);
        }
    }
    setEPA(e, epa, epa.selector.replace(/\./g, " ").substr(1));
    return e;
};

//----------------------------------------------------------------
// E: Element Factory
//----------------------------------------------------------------

// splitProps: (epaIn, props) -> [epaOut, rules]
//
// Separate an EProps into its non-CSS and CSS parts.
//
//   epaIn: inherited factory EPA (non-CSS EProps)
//   props: user-provided EProps
//   epaOut: resulting EPA
//   rules: CSS rules that apply CSS properties from `props`
//          Note: CSS rule = selector + declaration block (object, here)
//
let splitProps = (epaIn, propsIn) => {
    if (propsIn == null) {
        return [epaIn, []];
    }
    if (typeof propsIn != "object") {
        throw new Error("Bad `props` value");
    }

    let epa = {...epaIn};
    let rules = [];

    let split = (props, selector) => {
        let decls;

        for (let key in props) {
            let value = props[key];
            if (key[0] == "$") {
                epa[key] = value;
                if (selector) {
                    throw new Error("Non-CSS option inside pattern rule: "
                                    + selector + " {" + key + ": ...}")
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

    return [epa, rules];
};

// Create/initialize a DOM element
//
let createElem = (elem, epaBase, eprops, contentArgs) => {
    let [epa, rules] = splitProps(epaBase, eprops);
    elem = elem || newElement(epa.$tagName, epa.$namespaceURI);
    setElem(elem, epa, rules);
    if (contentArgs[0]) {
        // TBO: don't create cell when values are already computed
        // TBO: don't re-parent all children on update
        use(cell(function setContentX() {
            return setContent(elem, contentArgs);
        }));
    }
    return elem;
};

// Create a derived FactoryState
//
let newFactoryState = (epaBase, props) => {
    let [epa, rules] = splitProps(epaBase, props);
    if (rules.length > 0) {
        epa.selector = epa.selector + "." + getUniqueName(epa.$class);
        defineRules(rules, epa.selector);
    }
    return epa;
};

// Construct a new factory function/object.
//
let newFactory = (epa) => {
    let E = (eprops, ...content) => createElem(null, epa, eprops, content);
    E.newClass = (eprops) => newFactory(newFactoryState(epa, eprops));
    return E;
};

let Div = newFactory(rootEPA);

let assign = (elem, eprops, ...content) =>
    createElem(elem, rootEPA, eprops, content);

export {
    Div as default,
    Div,
    assign,
};
