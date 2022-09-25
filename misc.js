// Misc. utility functions

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


export {override, clone, set, append, map, L};

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

test.eq({a: 2, b: 4}, map({a:1, b:2}, x => x*2));
