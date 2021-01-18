// test.js:  Unit testing utilities

"use strict";

let idRE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

function isObject(v) {
    return typeof v === 'object' && v !== null;
}

// used by getPrototypeName()
let seenPrototypes = [];

// Return a name that uniquely identifies the prototype of `obj`
//
function getPrototypeName(obj) {
    let p = Object.getPrototypeOf(obj);
    if (p === Object.prototype) {
       return 'Object.prototype';
    } else if (p === Array.prototype) {
        return 'Array.prototype';
    } else if (! isObject(p)) {
        return serialize(p);
    }

    // Invent a name for p, unless we've already invented one
    let ndx = seenPrototypes.indexOf(p);
    if (ndx == -1) {
        ndx = seenPrototypes.length;
        seenPrototypes[ndx] = p;
    }
    return 'proto' + ndx;
}

let hexByte = ch => {
    let n = ch.charCodeAt(0);
    return (n < 16 ? '0' : '') + n.toString(16);
}

let escapeChar = ch =>
    ch == '\\' ? '\\\\' :
    ch == '"' ? '\\"' :
    ch == '\n' ? '\\n' :
    ch == '\t' ? '\\t' :
    ch == '\r' ? '\\r' :
    '\\x' + hexByte(ch);

// Return a string that can uniquely identifies values.  The string in in
// JavaScript source syntax for numbers, strings, booleand, and simple cases
// of arrays and objects.  When an object appears more than once in a single
// serialization, either in circular data structures or not, occurrences
// after the first are serialized as "@<N>", identifying the Nth serialized
// object.
//
function serialize(value) {
    let seen = new Map();
    let seenNextID = 1;

    let ser = (x) => {
        if (typeof x === 'string') {
            return '"' + x.replace(/[\\"\x00-\x1f\x7f-\xff]/g, escapeChar) + '"';
        } else if (typeof x === 'function') {
            return 'Function ' + x.name;
        } else if (!isObject(x)) {
            return String(x);
        } else if (seen.has(x)) {
            return '@' + seen.get(x);
        }

        seen.set(x, seenNextID++);

        let protoName = getPrototypeName(x);
        let a = [];
        let arrayKeys = new Set();

        // Handle array properties as `ser(value)`
        if (protoName === 'Array.prototype') {
            for (let ndx = 0; ndx < x.length; ++ndx) {
                arrayKeys.add(String(ndx));
                a.push(ser(x[ndx]))
            }
            arrayKeys.add("length");
        }

        // Handle non-array properties as `ser(key): ser(value)`
        let ownNames = Object.getOwnPropertyNames(x).sort();
        ownNames.forEach( function (key) {
            if (arrayKeys.has(key)) {
                return;
            }
            let value;
            try {
                value = x[key];
            } catch (x) {
                value = '<ERROR!>';
            }

            let d = Object.getOwnPropertyDescriptor(x, key);

            a.push( (d.enumerable ? '' : '~') +
                    (idRE.test(key) ? key : ser(key)) + ':' +
                    ser(value) );
        });

        if (protoName === 'Array.prototype') {
            return '[' + a.join(',') + ']';
        } else {
            if (protoName !== 'Object.prototype') {
                a.push('__proto__:' + protoName);
            }
            return '{' + a.join(',') + '}';
        }
    }

    return ser(value);
}

// Write to stderr without buffering
let isBrowser = (typeof window !== "undefined" &&
                 typeof window.document !== "undefined");
let puts;
if (isBrowser) {
    puts = str => console.log(str);
} else {
    let fs = require('fs');
    puts = str => fs.writeSync(2, str);
}

// Create and throw error, skipping `level` levels of the stack trace.
//
function errorAt(level, message) {
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
}

// Like C sprintf, but with only:
//   %% -> %
//   %s -> String(arg)
//   %q -> serialize(arg)
//   %a -> serialize(a[0]) serialize(a[1]) ...
//
function sprintf(fmt) {
    var argno = 1;
    var a = arguments;
    function repl(s) {
        if (s == '%%') {
            return '%';
        } else if (s == '%s') {
            return String(a[argno++]);
        } else if (s == '%d') {
            return String(Number(a[argno++]));
        } else if (s == '%q') {
            return serialize(a[argno++]);
        } else if (s == '%a') {
            let arg = a[argno++];
            let o = [];
            for (let ii = 0; ii < a.length; ++ii) {
                o.push(serialize(arg[ii]));
            }
            return o.join(', ');
        } else {
            errorAt(4, 'unsupported format string: ' + s);
        }
    }
    return fmt.replace(/%./g, repl);
}

// Write `sprintf(fmt, ...)` to stdout.
//
function printf(...args) {
    puts(sprintf(...args));
}

function failAt(level, fmt, ...args) {
    errorAt(level+1, sprintf(fmt, ...args));
}

function fail(fmt, ...args) {
    failAt(2, fmt, ...args);
}

function isEQ(a, b) {
    return a === b || serialize(a) === serialize(b);
}

// Verify that two equivalent arguments are passed, and indicate an error
// (if any) at the calling function ancestor identified by `level`.
//
function eqAt(level, a, b, c, ...garbage) {
    if (c !== undefined) {
        failAt(level+1, "extraneous arguments: %a", {c, ...garbage});
    }

    if (!isEQ(a, b)) {
        failAt(level+1, "values not equal\n  A: %q\n  B: %q\n", a, b)
    }
}

function eq(...args) {
    return eqAt(2, ...args);
}

function assert(cond) {
    if (!cond) {
        fail("Assertion failed!");
    }
}


exports.serialize = serialize;
exports.sprintf = sprintf;
exports.printf = printf;
exports.isEQ = isEQ;
exports.eq = eq;
exports.eqAt = eqAt;
exports.failAt = failAt;
exports.fail = fail;
exports.assert = assert;


////////////////////////////////////////////////////////////////
// Tests
////////////////////////////////////////////////////////////////

function expectError(f, ...args) {
    let err = null;
    try {
        f.call(null, ...args);
    } catch (e) {
        err = e;
    }
    if (err === null) {
        throw new Error(f.name + " did not throw...");
    }
}

// serialize
assert("1" === exports.serialize(1));
assert('"a"' === exports.serialize("a"));
assert("[1,2]" === exports.serialize([1,2]));
assert("{a:3}" === exports.serialize({a:3}));
assert('"a\\t\\r\\n\\\\\\"\\x01\\x02\\xf3\\xff"' ===
       exports.serialize('a\t\r\n\\"\x01\x02\xf3\xff'));

// eq

eq(1, 1);
eq({}, {});
expectError(eq, 1, 2);
eq(eq, exports.eq);

// sprintf

eq("1,2", exports.sprintf("%s,%d", 1, 2));
eq("a[1,2]", exports.sprintf("a%q", [1,2]));
eq("a: 1, 2", exports.sprintf("a: %a", [1,2]));
eq("{a:1,b:2}", exports.sprintf("%q", {a:1,b:2}));
