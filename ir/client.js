// ROP/WS client for the brower environment

import * as I from "./i.js";
import E from "./e.js";
import { Agent } from "./rop.js";

const ws = new WebSocket("ws://localhost:8002/rop");
const agent = new Agent(ws);

Error.stackTraceLimit = 100;

const main = () => {
    let content = I.cell(_ => {
        let recentKeys = agent.getRemote(1);
        let str = I.ifPending(recentKeys(), s => `Pending: ${s} ...`);
        return str || E({$tag: "i", fontSize: "80%"}, "--empty--");
    });

    E({
        $element: document.body,
        backgroundColor: "#aaa",
        margin: 20,
        font: "20px 'Avenir Next'",
        textAlign: "center",
    }, content);
};

I.use(I.cell(main));
