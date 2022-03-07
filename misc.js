// Misc. utility functions
//

import * as test from "./test.js";

// MODIFIES `a`
//
function override(a, b, ...others) {
    return b == undefined
        ? a
        : override(Object.assign(a, b), ...others);
}

// Non-mutating functions...

function clone(obj) {
    let o = (obj instanceof Array
             ? []
             : Object.create(Object.getPrototypeOf(obj)));
    return Object.assign(o, obj);
}

function set(obj, k, v) {
    let o = clone(obj);
    o[k] = v;
    return o;
}

function append(a, b, ...others) {
    if (!b) {
        return a;
    }
    let o = (b.length == 0 ? a :
             a.length == 0 ? b :
             [...a, ...b]);
    return append(o, ...others);
}

function map(obj, fn) {
    let o = Object.create(Object.getPrototypeOf(obj));
    for (let [key, value] of Object.entries(obj)) {
        o[key] = fn(value);
    }
    return o;
}

// Convert array of lines (if needed) to string
//
let L = (ary) => (ary instanceof Array ? [...ary, ''].join('\n') : ary);

// Construct a sexpr node
let N = (typ, ...elems) => {
    elems.T = typ;
    return elems;
};

// Serialize a JavaScript value using an S-expression-like syntax.
//
// * Primitive types are serialized as JavaScript source.
// * A "record" (an object whose T property is a string) is
//   serialized as "(T ELEMS...)" where ELEMS are the array
//   values starting at index 0, delimited by a space character.
//     For example:  {T:"Foo", "0":2, "1":3}  -->  (Foo 2 3)
// * Other objects are serialized as `[ELEMS...]`
//     For example:  [1,2,3]  -->  [1 2 3]
//
// `formatters` allows the client to customize the appearance of records
// based on their T value, by setting formatters[T] to a function:
//     (value, fmt) -> string
// It should return the serialization of value.  Its second argument is
// a function (of the same type) that serializes values.
//
let sexprFormatter = formatters => {
    formatters = formatters ?? Object.create(null);

    let format = node => {
        if (typeof (node ?? undefined) !== "object") {
            return test.serialize(node);
        }

        let t = typeof node.T == "string" ? node.T : false;
        if (t && t in formatters) {
            return formatters[t](node, format);
        }

        // serialize array members
        let elems = [];
        for (let ii = 0; node[ii] !== undefined; ++ii) {
            elems.push(format(node[ii]));
        }
        let text = elems.join(' ');

        return (t ? "(" + t + (text === "" ? "" : " " + text) + ")"
                : "[" + text + "]");
    }
    return format;
}

export {override, clone, set, append, map, L, N, sexprFormatter};

let o = {a: 1};
test.eq(set(o, "a", 2), {a: 2});
test.eq(set(o, "b", 2), {a: 1, b: 2});
test.eq(o, {a: 1});

o = {a: 1};
let oc = clone(o);
test.eq(o, oc);
test.eq(false, o === oc);

test.eq([5,4,3,2,1], append([5,4], [3,2,1]));
test.eq([1,2], append([1,2], []));
test.eq([3,4], append([], [3,4]));
test.eq([1,2], append([1], [2]));

let f = sexprFormatter(null);
test.eq(f(["Foo", ["abc", 2, {T: "Bar"}]]),
        '["Foo" ["abc" 2 (Bar)]]')

test.eq({a: 2, b: 4}, map({a:1, b:2}, x => x*2));
