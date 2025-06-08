// PEG combinator library supporting stateful parsing.
//
// A pattern is an object that represents a syntactic construct.  It
// implements a member function `match` that determines whether the contents
// of a given string, at a given offset, match the pattern.  On success, it
// returns the offset following the match and an array of zero or more
// "captures".
//
// The `P`, `R`, and `L` functions exported by this module construct simple
// patterns and combine patterns into sequences or alternatives.
//
//  Expression       Returns a pattern that will match...
//    P(string)        one occurrence of the string
//    P(number)        that number of characters
//    P(array)         whatever the first succeeding element matches
//    P(function)      what the user-defined function matches
//    P(pattern)       (returns pattern unchanged)
//    P(a, b, ...)     a, followed by b, ...; succeeds only if all succeed
//    R(...ranges)     a character within a set of ranges
//    L(_ => p)        p (evaluation of `p` is deferred to match time)
//    p.c              p, capturing the text it matched as a string
//    p.cpos           p, capturing start pos before p's captures
//    p.cc(...caps)    p, capturing constants `...caps`
//    p.ca(...tags)    p, capturing p's captures appended to [...tags]
//    p.cf(fn)         p, capturing fn(captures of p); fn: Array -> Array
//    p.x(n)           n or more repetitions of p
//    p.x0             same as p.x(0)
//    p.x1             same as p.x(1)
//    p.at             empty string if p succeeds (positive lookahead)
//    p.not            empty string if p fails (negative lookahead)
//    p.non            match one character if p fails
//    p.orNot          match p, or "" if p fails
//
// Arrays express PEG's "ordered choice" construct.  After converting
// elements of the array to patterns, it attempts to match them, in order,
// to the string; the first match is used.
//
// `L(function)` creates a "lazy" pattern, enabling recursive patterns.  At
// match time it calls the user-supplied function that returns a pattern
// object that will be used to perform the match.  This function can
// reference a variable that has been initialized at match time, and that
// was not yet initialized when `L()` was called.
//
// User-defined patterns can be constructed with `P(function)`.  The
// supplied function has the same type signature as Pattern.match:
//
//   match(subject, pos, state) -> [posOut, captures, stateOut] | false
//     subject = string to match
//     pos = position to start match in subject
//     state = match state
//
//     result: false => failure to match; otherwise:
//       posOut = position in subject following the match
//       stateOut = resulting match state
//       captures = an array of captured values
//
// Captures: `match` always returns an *array* of captured values.  Most of
// the "primitive" patterns summarized above do not capture values, so they
// return an empty array.  The primitives that match *successive*
// sub-patterns -- `P(a, b, ...)` and `p.x(n)` -- append their captures
// together.  In the case of ordered choice -- `P([a, b, ...])` -- only the
// captures of the succeeding pattern are returned.  Lookahead primitives
// return no captures.
//
// State: User-defined functions can use this feature to communicate data
// between successive matches.  Patterns implemented in this library neither
// access nor modify state; they simply return the state they are passed.
// In the case of *successive* matches, state is "threaded through": the
// output of each successful match is fed into the next match.
//
// Notes & observations:
//
//   - P([]) always fails.
//
//   - P() always succeeds (without advancing pos), as do P(0) and P("").
//
//   - p.x0 always succeeds, maybe without advancing.
//
//   - P([p, 0]) == p.orNot
//
//   - P(1).not matches only at the end of the subject string.
//
//   - Beware of patterns that can succeed without advancing.  Applying
//     `.x0`, `.x1`, or `.x(N)` to them will create a pattern that can
//     infinitely loop when matching.
//
//   - Beware of recursive patterns that can recurse before advancing
//     ("left-recursive rules").  These are likely to infinitely loop.
//
//   - p.ca("Tag") can be used to create S-expression-like nodes.  For
//     example, if p's captures are "field" and "value", then p.ca("NV") has
//     a single capture, the array `["NV", "field", "value"]`.
//
//   - Regular expression analogs:
//       /./          P(1)
//       /a*/         P("a").x0
//       /a+/         P("a").x1
//       /a?/         P("a").orNot
//       /ab|./       P(["ab", 1])
//       /[abc]/      P("abc".split(""))      or  P(["a", "b", "c"])
//       /[^abc]/     P("abc".split("")).non
//       /[A-Z0-9_]/  R("AZ", "09", "__")
//       /(a)/        P("a").c
//       /()a/        P("a").cpos
//
//   - Unlike regular expressions...
//
//      * PEG patterns never backtrack.  For example, P(p.x0, p) will always
//        fail, because `p.x0` will consume all the matches, leaving none
//        for `p` to match.
//
//      * Pattern.match is always "rooted".  Regexes are usually used to
//        find something *within* a string.  To find the first occurrence of
//        a pattern within a string, use `match` with a pattern like this:
//
//            P(p.non.x0, p.c.cpos)
//

const append = (a, b) =>
      (b.length == 0 ? a :
       a.length == 0 ? b :
       [...a, ...b]);

const NoCaptures = Object.freeze([]);

const matcherOfString = str => {
    const strlen = str.length;
    return (subj, pos, state) => {
        for (let ii = 0; ii < strlen; ++ii) {
            if (subj.charCodeAt(pos+ii) !== str.charCodeAt(ii)) {
                return false;
            }
        }
        return [pos + strlen, NoCaptures, state];
    };
};

const matcherOfArray = a => {
    const patterns = a.map(P1);
    if (patterns.every(p => (typeof p.source == "string"
                             && p.source.length == 1))) {
        // all single-character alternatives => use indexOf
        const allChars = patterns.map(p => p.source).join("");
        return ((subj, pos, state) =>
            allChars.indexOf(subj[pos]) >= 0 && [pos+1, NoCaptures, state]);
    }
    const matchFns = patterns.map(p => p.match);
    return (subj, pos, state) => {
        for (const m of matchFns) {
            const result = m(subj, pos, state);
            if (result) {
                return result;
            }
        }
        return false;
    };
};

class Pattern {
    constructor(match, source) {
        this.match = match;
        this.source = source;
    }

    get at() {
        return new Pattern((subj, pos, state) =>
            this.match(subj, pos, state) && [pos, NoCaptures, state]);
    }

    get not() {
        return new Pattern( (subj, pos, state) =>
            !this.match(subj, pos, state) && [pos, NoCaptures, state]);
    }

    get orNot() {
        return new Pattern( (subj, pos, state) =>
            this.match(subj, pos, state) || [pos, NoCaptures, state]);
    }

    get non() {
        return new Pattern( (subj, pos, state) =>
            (pos < subj.length
             && !this.match(subj, pos, state)
             && [pos+1, NoCaptures, state]));
    }

    get c() {
        const match = (subj, pos, state) => {
            const result = this.match(subj, pos, state);
            if (result) {
                result[1] = [subj.slice(pos, result[0])];
            }
            return result;
        };
        return new Pattern(match);
    }

    ca(...pre) {
        const pa = [...pre];
        return this.cf( caps => [append(pa, caps)] );
    }

    cc(...args) {
        const caps = [...args];
        return P((subj, pos, state) => {
            const r = this.match(subj, pos, state);
            return r && [r[0], caps, r[2]];
        });
    }

    cf(fn) {
        const match = (subj, pos, state) => {
            const r = this.match(subj, pos, state);
            return r && [ r[0], fn(r[1]), r[2] ];
        };
        return new Pattern(match);
    }

    get cpos() {
        return P((subj, pos, state) => {
            const r = this.match(subj, pos, state);
            return r && [r[0], append([pos], r[1]), r[2]];
        });
    }

    x(minReps) {
        if (minReps < 0) {
            throw new Error("Pattern.x(-N)");
        }
        const matchThis = this.match;
        const match = (subj, pos, state) => {
            let allCaptures = NoCaptures;
            let caps;
            let reps;
            let result;
            for (reps = 0; ; ++reps) {
                result = matchThis(subj, pos, state);
                if (result == false) {
                    break;
                }
                [pos, caps, state] = result;
                allCaptures = append(allCaptures, caps);
            }
            if (reps < minReps) {
                return false;
            }
            return [pos, allCaptures, state];
        };
        return new Pattern(match);
    }

    get x0() {
        return this.x(0);
    }

    get x1() {
        return this.x(1);
    }
}

const P1 = value => {
    let match;
    if (typeof value == "string") {
        match = matcherOfString(value);
    } else if (typeof value == "number") {
        if (value < 0) {
            throw new Error("Pattern(-N)");
        }
        match = (subj, pos, state, _) =>
            pos + value <= subj.length && [pos+value, NoCaptures, state];
    } else if (typeof value == "function") {
        match = value;
    } else if (Array.isArray(value)) {
        match = matcherOfArray(value);
    } else if (value instanceof Pattern) {
        return value;
    } else {
        throw new Error("Pattern(" + typeof value + ") is invalid: " + value);
    }

    return new Pattern(match, value);
};

// Convert arguments to patterns and return pattern that matches all of them
// in succession.  On success, resulting captures are all of the captures
// from all the pattern matches, appended together.
//
const P = (...args) => {
    if (args.length == 1) {
        return P1(args[0]);
    }
    const matchFns = args.map(v => P1(v).match);
    const match = (subj, pos, state) => {
        let allCaptures = NoCaptures;
        let caps;
        for (const m of matchFns) {
            const result = m(subj, pos, state);
            if (!result) {
                return false;
            }
            [pos, caps, state] = result;
            allCaptures = append(allCaptures, caps);
        }
        return [pos, allCaptures, state];
    }
    return new Pattern(match);
};

// Match characters in a set of inclusive ranges.  Each argument is a
// two-character string.
//
// E.g.:  R("AZ", "az", "09") matches ASCII alphanumeric characters
//
const R = (...ranges) => {
    const matchChar = (code) => {
        for (const range of ranges) {
            if (range.charCodeAt(0) <= code &&
                range.charCodeAt(1) >= code) {
                return true;
            }
        }
        return false;
    };
    return P1((subj, pos, state) =>
             matchChar(subj.charCodeAt(pos)) && [pos+1, NoCaptures, state]);
};

// Construct lazy pattern.  `fn` will be called at match-time to obtain a
// pattern.
//
const L = fn =>
      P((subj, pos, state) => fn().match(subj, pos, state));

export { P, R, L };
