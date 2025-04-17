import test from "./test.js";
import {intern, memoize} from "./intern.js";

const {assert, eq} = test;

//----------------------------------------------------------------
// tests
//----------------------------------------------------------------

const eqq = (a, b) => (a === b || eq(["A", a], ["B", b]));

const ti = (v) => {
    if (v instanceof Object) {
        // clone
        const vc = v instanceof Array ? [] : {};
        Object.assign(vc, v);

        const vi = intern(v);
        eq(vi, v);
        eqq(vi, intern(vc));
    } else {
        eqq(v, intern(v));
    }
};

// test intern

ti(1);
ti("abc");
ti(true);
ti(null);
ti(undefined);

ti([]);
ti([1, 2, 3]);

ti({a: 1, b: 2, c: []});

// test memoize

let log = "";
const f = (...args) => {
    const v = args.join();
    log += "(" + v + ")";
    return v;
};

const mf = memoize(f);
eq(mf(1,2,3), "1,2,3");
eq(mf(1,2,3), "1,2,3");
eq(mf(4,5), "4,5");
eq(log, "(1,2,3)(4,5)");
