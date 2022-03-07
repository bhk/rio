// PEG combinator library supporting stateful parsing.
//
// A pattern is an object that represents a syntactic entity.
//
// A pattern's `match` field is a function that examines a string
// ("subject") at a given starting position to see whether it matches, and
// either succeeds or fails.  On success, it describes the length of the
// match (0 or more characters) and an array of captured values.
//
// Patterns can be constructed and composed using the following functions
// and methods:
//
//                   Returns a pattern that will match...
//    P(string)        one occurrence of `string`
//    P(number)        some number of characters
//    P(pattern)       pattern (returns pattern unmodified)
//    P(function)      whatever `function` matches
//    S(string)        any character in string
//    NS(string)       any character NOT in string
//    R(pairs...)      a character within a set of ranges
//    V(name)          a non-terminal (g.name holds the pattern)
//    and(p, q, ...)   p followed by q, ...
//    or(p, q, ...)    p, or else q (the first one to match)
//    CC(...caps)      empty string, capturing `...caps`
//    p.C              p, capturing the text it matched
//    p.A              p, capturing a single array that contains p's captures
//    p.X(n)           n or more successive occurrences of p
//    p.X0             same as p.X(0)
//    p.X1             same as p.X(1)
//    p.at             empty string iff p succeeds (positive lookahead)
//    p.not            empty string iff p fails (negative lookahead)
//    p.F(fun)         p, and call F to process its captures
//    p.G(g)           p, using grammar g
//
// Pre-constructed patterns:
//    cpos             capture current position
//    empty            always succeed (match empty string)
//    fail             always fail
//
// User-defined patterns can be constructed with `P(function)`.  The
// supplied function has this type signature:
//
//     (subject, pos, state, g) -> [pos, state, captures] | false
//
// `captures` must be an *array* of captured values.  Most of the pattern
// constructors above yield a pattern that captures no values, so they
// always return an empty array (`NoCaptures`).  The `CC`, `C`, and `A`
// operations yield patterns that capture specified values when the match
// succeeds.  `cpos` is a pre-constructed pattern that mathes the empty
// string and captures `pos`.
//
// The `state` value allows information to be propagated between succeesive
// matches.  When a sequence of matches are performed -- `and()` -- the
// value returned from each successful match is passed to the next match.
// None of the constructors above yield patterns that modify `state`; they
// simply pass the input state along.  Only user-defined patterns will
// modify or read state.
//
// General notes on captures and state:
//
// For "successive" matches, as in `and(p,q)` and `p.X(n)`, where one
// pattern is *followed by* another:
//
//   * `state` and `pos` are "threaded" through.  The results of each
//     successful match are fed into the next match.
//
//   * Captures of successive matches are appended.  If `p` captures
//     `["a"]` and `q` captures `["x", "y"]`, then `and(p,q)` captures
//     `["a", "x", "y"]` and `p.X(1)` will capture `["a", "a", "a"]`
//     when it matches three occurrences.
//
// The results of an ordered choice pattern -- `or(p,q)` -- are simply the
// rsults of the successful pattern.  Results of unsuccessful attempts are
// discarded, and state is not threaded between them.
//

import test from "./test.js";
import {append} from "./misc.js";

let NoCaptures = [];

function matcherOfString(str) {
    let strlen = str.length;
    return (subj, pos, state, g) => {
        if (subj.length < pos + strlen) {
            return false;
        }
        for (let ii = 0; ii < strlen; ++ii) {
            if (subj.charCodeAt(pos+ii) !== str.charCodeAt(ii)) {
                return false;
            }
        }
        return [pos + strlen, state, NoCaptures];
    }
}

class Pattern {
    constructor(match) {
        this.match = match;
    }

    // lookahead
    get at() {
        let p = this;
        return new Pattern((subj, pos, state, g) => (
            p.match(subj, pos, state, g) && [pos, state, NoCaptures]));
    }

    // negative lookahead
    get not() {
        let p = this;
        return new Pattern( (subj, pos, state, g) => (
            !p.match(subj, pos, state, g) && [pos, state, NoCaptures]));
    }

    get X0() {
        return this.X(0);
    }

    get X1() {
        return this.X(1);
    }

    // match minimum reps
    X(minReps) {
        if (minReps < 0) {
            throw new Error("reps<0");
        }
        let matchThis = this.match;
        let match = (subj, pos, state, g) => {
            let allCaptures = [];
            let caps;
            let reps = 0;
            let result;
            for (reps = 0;
                 (result = matchThis(subj, pos, state, g)) !== false;
                 ++reps) {
                [pos, state, caps] = result;
                allCaptures = append(allCaptures, caps);
            }
            if (reps < minReps) {
                return false;
            }
            return [pos, state, allCaptures];
        };
        return new Pattern(match);
    }

    // transform captures
    //    fn: array -> array
    F(fn) {
        let matchThis = this.match;
        let match = (subj, pos, state, g) => {
            let result = matchThis(subj, pos, state, g);
            if (!result) {
                return false;
            }
            let [p, st, caps] = result;
            return [p, st, fn(caps)];
        };
        return new Pattern(match);
    }

    get C() {
        let match = (subj, pos, state, g) => {
            let result = this.match(subj, pos, state, g);
            if (result) {
                result[2] = [subj.slice(pos, result[0])];
            }
            return result;
        };
        return new Pattern(match);
    }

    get A() {
        return this.F( caps => [ caps ] );
    }

    // match using a specified grammar
    //
    G(g) {
        return new Pattern( (subj, pos, state, _) =>
                            this.match(subj, pos, state, g));
    }
}

function P(value) {
    let match;
    if (typeof value == "string") {

        // match string exactly
        match = matcherOfString(value);

    } else if (typeof value == "number") {

        // match this many characters
        if (value < 0) {
            throw new Error("Pattern(negative)");
        }
        match = (subj, pos, state, _) =>
            pos + value <= subj.length && [pos+value, state, NoCaptures];

    } else if (typeof value == "function") {

        // use supplied function: (subj,pos,st,g) => (pos,st,caps)?
        match = value;

    } else if (value instanceof Pattern) {

        return value;

    } else {
        throw new Error("Invalid arg: " + String(value));
    }

    return new Pattern(match);
}

let empty = P(0);

let fail = P((subj, pos, state, g) => false);

// Sequence.
//
// Match all arguments in succession.  Captured values = all captures from
// matched patterns, appended.
//
function and(...args) {
    let patterns = args.map(P);
    let match = (subj, pos, state, g) => {
        let allCaptures = [];
        let caps;
        for (let pat of patterns) {
            let result = pat.match(subj, pos, state, g);
            if (!result) {
                return false;
            }
            [pos, state, caps] = result;
            allCaptures = append(allCaptures, caps);
        }
        return [pos, state, allCaptures];
    }
    return P(match);
}

// Ordered choice.
//
function or(...args) {
    let patterns = args.map(P);
    let match = (subj, pos, state, g) => {
        for (let pat of patterns) {
            let result = pat.match(subj, pos, state, g);
            if (result) {
                return result;
            }
        }
        return false;
    };
    return P(match);
}

// cpos: always match 0 characters & capture `pos`
//
let cpos = P((subj, pos, state, g) => [pos, state, [pos]]);

// constant capture: match 0 chars & capture all arguments
//
function CC(...args) {
    let caps = [...args];
    return P((subj, pos, state, g) => [pos, state, caps]);
}

// match characters in a set of inclusive ranges
//
// R("AZ", "az", "09")  ==>  alphanumeric character
//
function R(...ranges) {
    let matchChar = (code) => {
        for (let range of ranges) {
            if (range.charCodeAt(0) <= code &&
                range.charCodeAt(1) >= code) {
                return true;
            }
        }
        return false;
    };
    return P((subj, pos, state, g) =>
             matchChar(subj.charCodeAt(pos)) && [pos+1, state, NoCaptures]);
}

// match any of the characters in `chars`
//
function S(chars) {
    return P( (subj, pos, state, g) =>
              chars.indexOf(subj[pos]) >= 0 && [pos+1, state, NoCaptures]);
}


// match any character NOT in `chars`
//
function NS(chars) {
    if (chars.length == 0) {
        throw new Error("NS(emptyString)");
    }
    return P( (subj, pos, state, g) =>
              subj.length > pos
              && chars.indexOf(subj[pos]) < 0
              && [pos+1, state, NoCaptures]);
}

// match pattern stored in `g` under `name`
//
function V(name) {
    return P( (subj, pos, state, g) => {
        let p = g && g[name];
        if (p instanceof Pattern) {
            return g[name].match(subj, pos, state, g);
        }
        throw new Error('undefined non-terminal "' + name + '"' +
                        (g instanceof Object ? '' : ' (no grammar)'));
    });
}

export {P, S, NS, R, V, and, or, CC, cpos, empty, fail, NoCaptures};

////////////////////////////////////////////////////////////////
// tests
////////////////////////////////////////////////////////////////


function checkPat(str, pat, pos, ...captures) {
    if (!(pat instanceof Pattern)) {
        test.failAt(2, "`pat` is not a pattern");
    }
    let expected = pos === false ? false : [pos, {}, captures];
    let out = pat.match(str, 0, {}, {});
    test.eqAt(2, expected, out);
}

test.eq( matcherOfString("xy")("xyz", 0, null, null),
         [2, null, []] );

checkPat("xyz", fail, false);

checkPat("xyz", empty, 0);

checkPat("xyz", P("xy"), 2);
checkPat("xyz", P("y"), false);
checkPat("xyz", P(""), 0);

checkPat("xyz", cpos, 0, 0);
checkPat("xyz", CC("A", "B"), 0, "A", "B");
checkPat("xyz", P("x").C, 1, "x");
checkPat("xyz", P("x").C.A, 1, ["x"]);

checkPat("xyz", or(P("x"), P("y")), 1);
checkPat("xyz", or("x", "y"), 1);
checkPat("xyz", or("y", "x"), 1);
checkPat("xyz", or(P("y").C, P("x").C), 1, "x");
checkPat("xyz", or(), false);

checkPat("xyz", and(P("x"), P("y")), 2);
checkPat("xyz", and("x", "y"), 2);
checkPat("xyz", and("x", "z"), false);
checkPat("xyz", and(P("x").C, P("y").C), 2, "x", "y");

checkPat("xyz", P("y").X(0), 0);
checkPat("xxy", P("x").X(0), 2);
checkPat("xxy", P("x").X(1), 2);
checkPat("xxy", P("x").X(3), false);
checkPat("xxy", P("x").C.X(0), 2, "x", "x");

checkPat("abc", P("x").X0, 0);
checkPat("abc", P("x").X1, false);

checkPat("xyz", P(0), 0);
checkPat("xyz", P(1), 1);
checkPat("xyz", P(3), 3);
checkPat("xyz", P(4), false);

checkPat("xyz", P("x").C.at, 0);
checkPat("xyz", P("y").at, false);

checkPat("xyz", P("x").not, false);
checkPat("xyz", P("a").not, 0);

checkPat("xyz", S("ABx"), 1);
checkPat("xyz", S("xAB"), 1);
checkPat("xyz", S(""), false);

checkPat("xyz", NS("x"), false);
checkPat("xyz", NS("z"), 1);
checkPat("xyz", NS("z").X(0), 2);

checkPat("xyz", R("ax"), 1);
checkPat("xyz", R("aw"), false);
checkPat("xyz", R("ab", "xy").X(0), 2);

checkPat("xyz", P(1).C.F(c => c.map(ch => "@" + ch)), 1, "@x");

// grammar

let tg = {
    X: P("x").C,
    XY: and("x", V("Y")),
    Y: P("y").C,
};
checkPat("xyz", V("X").G(tg), 1, "x");
checkPat("xyz", V("XY").G(tg), 2, "y");

// state

// if n > 0, succeed, decrement N, and return old N
let dec = P( (subj, pos, st, g) => (
    st.n > 0 && [pos, {n: st.n-1}, [st.n]]
));

test.eq( dec.match("", 0, {n:0}),
         false);
test.eq( dec.match("", 0, {n:1}),
         [0, {n:0}, [1]] );
test.eq( or("x", dec, "z").match("", 0, {n:1}),
         [0, {n:0}, [1]] );
test.eq( dec.X(0).match("", 0, {n:3}),
         [0, {n:0}, [3, 2, 1]] );
