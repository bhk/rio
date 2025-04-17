import {fmtTime} from "./util.js";
import test from "./test.js";
let {eq} = test;


eq(fmtTime(-0.2), "0:00");
eq(fmtTime(1.9), "0:02");
eq(fmtTime("1.9"), "0:02");
eq(fmtTime(59.2), "0:59");
eq(fmtTime(69.2), "1:09");
eq(fmtTime(3659.2), "1:00:59");
