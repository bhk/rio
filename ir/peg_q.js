import { P, R, L } from "./peg.js";
import test from "./test.js";

const checkPat = (str, pat, pos, ...captures) => {
    if (!("match" in pat)) {
        test.failAt(2, "`pat` is not a pattern");
    }
    const expected = pos === false ? false : [pos, captures, {}];
    const out = pat.match(str, 0, {});
    test.eqAt(2, expected, out);
};

checkPat("xyz", P(0), 0);
checkPat("xyz", P(1), 1);
checkPat("xyz", P(3), 3);
checkPat("xyz", P(4), false);

checkPat("xyz", P("xy"), 2);
checkPat("xyz", P("y"), false);
checkPat("xyz", P(""), 0);

checkPat("xyz", P(["x", "y"]), 1);
checkPat("xyz", P(["y", "x"]), 1);
checkPat("", P(["x", "y"]), false);
checkPat("xyz", P(["x", "y", "aa"]), 1);
checkPat("xyz", P([P("y").c, P("x").c]), 1, "x");
checkPat("xyz", P([]), false);

checkPat("xyz", P(P(1)), 1);

checkPat("xyz", P("x").c, 1, "x");
checkPat("xyz", P(1).cpos, 1, 0);
checkPat("xyz", P(1).c.cpos, 1, 0, "x");
checkPat("xyz", P().cc("A", "B"), 0, "A", "B");
checkPat("xyz", P("x").c.ca(), 1, ["x"]);
checkPat("xyz", P("x").c.ca("X"), 1, ["X", "x"]);

checkPat("xyz", P("x", "y"), 2);
checkPat("xyz", P("x", "z"), false);
checkPat("xyz", P(P("x").c, P("y").c), 2, "x", "y");

checkPat("xyz", P("y").x0, 0);
checkPat("xxy", P("x").x0, 2);
checkPat("xxy", P("x").x1, 2);
checkPat("xxy", P("x").x(2), 2);
checkPat("xxy", P("x").x(3), false);
checkPat("xxy", P("x").c.x0, 2, "x", "x");

checkPat("xyz", P("x").c.at, 0);
checkPat("xyz", P("y").at, false);

checkPat("xyz", P("x").not, false);
checkPat("xyz", P("a").not, 0);

checkPat("xyz", R("ax"), 1);
checkPat("xyz", R("aw"), false);
checkPat("xyz", R("ab", "xy").x0, 2);

checkPat("xyz", P(1).c.cf(c => c.map(ch => "@" + ch)), 1, "@x");

const lazyp = P("<", P([L(_ => lazyp), ""]), ">");
checkPat("<<>>", lazyp, 4);

// state

// if n > 0, succeed, decrement N, and return old N
const dec = P( (subj, pos, st) => (st.n > 0 && [pos, [st.n], {n: st.n-1}]) );

test.eq( dec.match("", 0, {n:0}),
         false);
test.eq( dec.match("", 0, {n:1}),
         [0, [1], {n:0}] );
test.eq( P(["x", dec, "z"]).match("", 0, {n:1}),
         [0, [1], {n:0}] );
test.eq( dec.x0.match("", 0, {n:3}),
         [0, [3, 2, 1], {n:0}] );
