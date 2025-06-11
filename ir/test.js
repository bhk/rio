// test.js:  Unit testing utilities
//
// This module can be conditionally excluded from a bundle by substituting
// `no-test.js` for `test.js`, for example, in package.json:
//
//    "browser": { "./test.js": "./no-test.js" },
//
// When a browser-targeted bundle is built, a sufficiently smart bundler
// will remove the test code as dead code if the tests are conditionally
// skipped, as in the following example:
//
//    import test from "./test.js";
//
//    if (test) {
//       let {eq, assert} = test;
//       ...tests...
//    }
//

import { serialize, sprintf } from "./serialize.js";

// This appears to prevent truncated stack traces in Node & Chrome
Error.stackTraceLimit = 100;

// Write to stderr without buffering
let isBrowser = (typeof window !== "undefined" &&
                 typeof window.document !== "undefined");
let puts;
if (isBrowser) {
    puts = str => console.log(str);
} else {
    let fs = await import('fs');
    puts = str => fs.writeSync(2, str);
}

// Create and throw error, skipping `level` levels of the stack trace.
//
let errorAt = (level, message) => {
    let err = new Error('[errorAt]');
    let s = err.stack;
    let i0 = s.indexOf('\n');   // skip "Error: [errorAt]"
    // skip "   at ..." lines
    let ii = i0;
    for (let n = 0; n < level && ii > 0; ++n) {
        ii = s.indexOf('\n', ii+1);
    }
    if (ii > 0) {
        err.stack = 'Error: ' + message + s.slice(ii) +
            '\n[internal]' + s.slice(i0, ii);
    }
    throw err;
};

// Write `sprintf(fmt, ...)` to stdout.
//
let printf = (...args) => {
    puts(sprintf(...args));
};

let failAt = (level, fmt, ...args) => {
    errorAt(level+1, sprintf(fmt, ...args));
};

let fail = (fmt, ...args) => {
    failAt(2, fmt, ...args);
};

let isEQ = (a, b) => {
    return a === b || serialize(a) === serialize(b);
};

// Verify that two equivalent arguments are passed, and indicate an error
// (if any) at the calling function ancestor identified by `level`.
//
let eqAt = (level, a, b, c, ...garbage) => {
    if (c !== undefined) {
        failAt(level+1, "extraneous arguments: %a", {c, ...garbage});
    }

    if (!isEQ(a, b)) {
        failAt(level+1, "values not equal\n  A: %q\n  B: %q\n", a, b)
    }
};

let eq = (...args) => {
    return eqAt(2, ...args);
};

let assert = (cond) => {
    if (!cond) {
        fail("Assertion failed!");
    }
    return cond;
};

////////////////////////////////////////////////////////////////
// Tests
////////////////////////////////////////////////////////////////

let expectError = (f, ...args) => {
    let err = null;
    try {
        f.call(null, ...args);
    } catch (e) {
        err = e;
    }
    if (err === null) {
        throw new Error(f.name + " did not throw...");
    }
};

// eq

eq(1, 1);
eq({}, {});
expectError(eq, 1, 2);

export default {
    serialize, sprintf, printf, isEQ, eq, eqAt, failAt, fail, assert
};
