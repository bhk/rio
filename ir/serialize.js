// serialize
//
// This module converts JS values to test for diagnostic and testing
// purposes.  This does not generate valid JS source.  When an object
// appears more than once in a single serialization, whether the data
// structure is cyclic or not, occurrences after the first are serialized as
// "@<N>", identifying the Nth serialized object.
//
// This is used by test.js as a means of comparing objects by value (not by
// reference).  For testing purposes, the serialization of a value should
// capture aspects that meaningfully affect behavior, like the prototype of
// the object.
//
// serialize(value) -> string
//
//   Convert `value` to a textual representation.
//
// sprintf(fmt, ...values) -> string
//
//   Output `fmt`, replacing format specifiers as follows:
//       `%%` -> %
//       `%s` -> String(arg)
//       `%q` -> serialize(arg)
//       `%a` -> serialize(a[0]) serialize(a[1]) ...
//
// customize(customSerialize) -> {serialize, srptinf}
//
//    Construct customized versions of serialize and sprintf, given a
//    function customSerialize: (value, recur) -> string.  `recur` can be
//    used to recursively serialize values nested within `value`.
//

const isObject = (v) =>
      typeof v === 'object' && v !== null;

// used by getPrototypeName()
const seenPrototypes = [];

// Return a name that uniquely identifies the prototype of `obj`
//
const getPrototypeName = (obj) => {
    const p = Object.getPrototypeOf(obj);
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
};

const idRE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

const serializeObject = (x, ser) => {
    const protoName = getPrototypeName(x);
    const a = [];
    const arrayKeys = new Set();

    // Handle array properties as `ser(value)`
    if (protoName === 'Array.prototype') {
        for (let ndx = 0; ndx < x.length; ++ndx) {
            arrayKeys.add(String(ndx));
            a.push(ser(x[ndx]))
        }
        arrayKeys.add("length");
    }

    // Handle non-array properties as `ser(key): ser(value)`
    const ownNames = Object.getOwnPropertyNames(x).sort();
    ownNames.forEach(key => {
        if (arrayKeys.has(key)) {
            return;
        }
        let value;
        try {
            value = x[key];
        } catch (x) {
            value = '<ERROR!>';
        }

        const d = Object.getOwnPropertyDescriptor(x, key);

        a.push( (d.enumerable ? '' : '~') +
                (idRE.test(key) ? key : ser(key)) + ': ' +
                ser(value) );
    });

    if (protoName === 'Array.prototype') {
        return '[' + a.join(', ') + ']';
    } else {
        if (protoName !== 'Object.prototype') {
            a.push('__proto__:' + protoName);
        }
        return '{' + a.join(', ') + '}';
    }
};

const escapeRE = /[\\"\x00-\x1f\x7f-\xff]/g;

const hexByte = ch => {
    const n = ch.charCodeAt(0);
    return (n < 16 ? '0' : '') + n.toString(16);
};

const escapeReplace = ch =>
    ch == '\\' ? '\\\\' :
    ch == '"' ? '\\"' :
    ch == '\n' ? '\\n' :
    ch == '\t' ? '\\t' :
    ch == '\r' ? '\\r' :
    '\\x' + hexByte(ch);

const makeSerializer = customSerialize => value => {
    const seen = new Map();
    let seenNextID = 1;

    const ser = (x) => {
        if (!isObject(x)) {
            // null, undefined, boolean, string
            return typeof x === 'string'
                ?  '"' + x.replace(escapeRE, escapeReplace) + '"'
                : String(x);
        } else if (typeof x === 'function') {
            return 'Function ' + x.name;
        } else if (seen.has(x)) {
            return '@' + seen.get(x);
        }
        const cust = customSerialize(x, ser);
        if (typeof cust == "string") {
            return cust;
        }
        seen.set(x, seenNextID++);
        return serializeObject(x, ser);
    }

    return ser(value);
};

const makeSprintf = serialize => (fmt, ...args) => {
    const repl = (s) => {
        if (s == '%%') {
            return '%';
        }
        const value = args.shift();
        const txt = s == '%s' ? String(value) :
              s == '%d' ? String(Number(value)) :
              s == '%q' ? serialize(value) :
              s == '%a' ? value.map(serialize).join(', ') :
              null;
        if (txt == null) {
            throw new Error('unsupported format string: ' + s);
        }
        return txt;
    };
    return fmt.replace(/%./g, repl);
};

const customize = customSerialize => {
    const serialize = makeSerializer(customSerialize);
    const sprintf = makeSprintf(serialize);
    return { serialize, sprintf };
};

const { serialize, sprintf } = customize(_ => null);

export {
    customize,
    serialize,
    sprintf,
};
