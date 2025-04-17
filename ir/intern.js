// intern.js: find a canonical, immutable, equivalent value
//
// TBO: Interned values accummulate in memory indefinitely.
//

// this value is different from all other values
const UNSET = {};

class Step {
    constructor(elem, prev) {
        this.elem = elem;
        this.prev = prev;
        this.nexts = new Map();
        this.value = UNSET;
    }

    next(elem) {
        if (this.nexts.has(elem)) {
            return this.nexts.get(elem);
        } else {
            const es = new Step(elem, this);
            this.nexts.set(elem, es);
            return es;
        }
    }
}

const interns = new Map();
const emptyArray = new Step();
const emptyObject = new Step();
const memoRoot = new Step();
const objectProto = Object.getPrototypeOf({});

const internSeq = (root, args, f) => {
    let step = root;
    for (const arg of args) {
        step = step.next(intern(arg));
    }
    if (step.value !== UNSET) {
        return step.value;
    }

    // create `ai` whose elements are all interned
    let ai = new Array(args.length);
    let rs = step;
    for (let i = args.length - 1; i >= 0; --i, rs = rs.prev) {
        ai[i] = rs.elem;
    }
    ai = f(ai);
    interns.set(ai, step);
    step.value = ai;
    return ai;
};

const memoize = f => {
    let root = memoRoot.next(f);
    return (...args) => internSeq(root, args, (a) => f(...a));
};

const internArray = a => internSeq(emptyArray, a, Object.freeze);

const internObject = (obj) => {
    let step = emptyObject;
    for (const [k,v] of Object.entries(obj)) {
        // k is a string (no need to call intern)
        step = step.next(k).next(intern(v));
    }
    if (step.value !== UNSET) {
        return step.value;
    }

    // create `obji` whose properties are all interned
    let obji = {};
    for (let rs = step; rs !== emptyObject; ) {
        const v = rs.elem;
        rs = rs.prev;
        const k = rs.elem;
        rs = rs.prev;
        obji[k] = v;
    }
    obji = Object.freeze(obji);
    interns.set(obji, step);
    step.value = obji;
    return obji;
};

// If `value` is an object whose constructor is `Array` or `Object`, return
// an immutable, canonical equivalent.  Otherwise, return `value`.
//
const intern = (value) => {
    return !(value instanceof Object) ? value :
        interns.has(value) ? value :
        value instanceof Array ? internArray(value) :
        Object.getPrototypeOf(value) == objectProto ? internObject(value) :
        value;
};

export {
    intern,
    memoize,
}
