// ROP/WS client for the brower environment

import { use, cell, ifPending, state } from "./i.js";
import { Div, assign } from "./e.js";
import { Agent } from "./rop.js";

Error.stackTraceLimit = 100;

const initialFuncs = {
    getNumber: _ => [number, incrNumber],
};
const ws = new WebSocket("ws://localhost:8002/rop");
const agent = new Agent(ws, {}, initialFuncs);

//----------------------------------------

const main = () => {
    console.log("main");
    const [number, numberGoUp] = agent.remotes.getNumber();
          //[state(0), n => null];
    console.log("button");

    const button = Div({
        $tagName: "input",
        $type: "button",
        $value: "Number Go Up",
        $onclick: (evt) => numberGoUp(1),
    });

    assign(document.body,
             { margin: 20, background: "#aaa" },
             button, Div(null, number));
};

ifPending(cell(main));
