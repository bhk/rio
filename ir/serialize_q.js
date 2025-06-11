// serialize_q.js
//
// Since serialize is a dependency of test.js, we cannot use test.js
// to test it.

import { serialize, sprintf, customize } from "./serialize.js";

const assert = (cond) => {
    if (!cond) {
        throw new Error("Assertion failed!");
    }
};

const eq = (a, b) => {
    if (a !== b) {
        console.log("a: " + a);
        console.log("b: " + b);
        assert(false);
    }
};

// test serialize

assert("1" === serialize(1));
assert('"a"' === serialize("a"));
assert("[1, 2]" === serialize([1,2]));
assert("{a: 3}" === serialize({a:3}));
assert('"a\\t\\r\\n\\\\\\"\\x01\\x02\\xf3\\xff"' ===
       serialize('a\t\r\n\\"\x01\x02\xf3\xff'));

// test sprintf

eq("1,2", sprintf("%s,%d", 1, 2));
eq("a[1, 2]", sprintf("a%q", [1,2]));
eq("a: 1, 2", sprintf("a: %a", [1,2]));
eq("{a: 1, b: 2}", sprintf("%q", {a:1,b:2}));

// test customize

const cust = (obj, recur) =>
      obj.X && recur(obj.X);

const {serialize: ser2, sprintf: spr2} = customize(cust);

eq("{a: {b: \"foo\"}}", ser2({a: {X: {b: {X: "foo"}}}}));
eq("abc[1]def", spr2("abc%qdef", {X: [1]}));
