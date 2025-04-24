// intern.js: find a canonical, immutable, equivalent value
//
// intern(value) : Return unique equivalent value.
//
//    Immutable values (strings, numbers, ...) are returned unchanged.
//
//    Arrays and Objects whose prototype matches that of Object (e.g. object
//    literals) are converted to a frozen clone whose members are all
//    interned.
//
//    Functions and other types of objects are returned unchanged.
//
// memoize(f)(...a) : Evaluate and cache f(...a).
//
//    Note that memoize can interact badly with reactive functions.  If
//    `f(...a)` accesses and reactive (changing) values, the memoized
//    form will return outdated results.
//
// TBO: Interned values accummulate in memory indefinitely.
//

const interns = new Map();      // interned value -> true
const stepValues = new Map();   // final step -> interned value

const arrayRoot = new Map();
const objectRoot = new Map();
const memoRoot = new Map();

const objectProto = Object.getPrototypeOf({});

const next = (step, value) => {
    if (step.has(value)) {
        return step.get(value);
    }
    const m = new Map();
    step.set(value, m);
    return m;
};

const internSeq = (root, a, f) => {
    let step = root;
    for (const arg of a) {
        step = next(step, intern(arg));
    }
    if (stepValues.has(step)) {
        return stepValues.get(step);
    }

    // create `ai` whose elements are all interned
    let ai = new Array(a.length);
    for (let i = 0; i < a.length; ++i) {
        ai[i] = intern(a[i]);
    }
    ai = f(ai);   // f = Object.freeze for arrays...

    stepValues.set(step, ai);
    interns.set(ai, true);

    return ai;
};

const memoize = f => {
    let step = next(memoRoot, f);
    return (...args) => internSeq(step, args, (a) => f(...a));
};

const internArray = a => internSeq(arrayRoot, a, Object.freeze);

const internObject = obj => {
    let step = objectRoot;
    for (const [k,v] of Object.entries(obj)) {
        // k is a string (no need to call intern)
        step = next(step, k);
        step = next(step, intern(v));
    }
    if (stepValues.has(step)) {
        return stepValues.get(step);
    }

    // create `obji` whose properties are all interned
    let obji = {};
    for (const [k,v] of Object.entries(obj)) {
        obji[k] = intern(v);
    }
    Object.freeze(obji);

    stepValues.set(step, obji);
    interns.set(obji, true);

    return obji;
};

// If `value` is an object whose constructor is `Array` or `Object`, return
// an immutable, canonical equivalent.  Otherwise, return `value`.
//
const intern = value => {
    return !(value instanceof Object) ? value :
        interns.has(value) ? value :
        value instanceof Array ? internArray(value) :
        Object.getPrototypeOf(value) == objectProto ? internObject(value) :
        value;
};

export {
    intern,
    memoize,
};
