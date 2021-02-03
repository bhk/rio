// Misc. utility functions
//

let test = require("test.js");

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

// Serialize a Lua "record" value in an S-expression-like syntax.
//
//  * Tables where t.T == nil: Serialize t[1...] as a vector.
//        [1, 2, 3]           -->   "[1 2 3]"
//  * Tables where t.T ~= nil: Serialize as a list whose first element
//    is a symbol given by t.T, and subsequent elements are t[1...].
//        {T="Foo", 1, 2}     //>  "(Foo 1 2)"
//  * Other values: use test.serialize.
//
let sexprFormatter = formatters => {
    formatters = formatters ?? Object.create(null);

    let format = node => {
        if (typeof (node ?? undefined) !== "object") {
            return test.serialize(node);
        }

        let f = formatters[node.T || "[]"]
        if (f) {
            return f(node, format);
        }

        let elems = [];
        for (let ii = 0; node[ii] !== undefined; ++ii) {
            elems.push(format(node[ii]));
        }
        let text = elems.join(' ');
        return (node.T
                ? "(" + node.T + (text === "" ? "" : " " + text) + ")"
                : "[" + text + "]");
    }
    return format;
}


exports.override = override;
exports.clone = clone;
exports.set = set;
exports.append = append;
exports.map = map;
exports.sexprFormatter = sexprFormatter;

let o = {a: 1};
test.eq(set(o, "a", 2), {a: 2});
test.eq(set(o, "b", 2), {a: 1, b: 2});
test.eq(o, {a: 1});

o = {a: 1};
let oc = clone(o);
test.eq(o, oc);
test.eq(false, o === oc);

test.eq([5,4,3,2,1], exports.append([5,4], [3,2,1]));
test.eq([1,2], exports.append([1,2], []));
test.eq([3,4], exports.append([], [3,4]));
test.eq([1,2], exports.append([1], [2]));

let f = sexprFormatter(null);
test.eq(f(["Foo", ["abc", 2, {T: "Bar"}]]),
        '["Foo" ["abc" 2 (Bar)]]')

test.eq({a: 2, b: 4}, map({a:1, b:2}, x => x*2));
