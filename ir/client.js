// ROP/WS client for the brower environment

import * as I from "./i.js";
import E from "./e.js";
import { Agent } from "./rop.js";

Error.stackTraceLimit = 100;

const ws = new WebSocket("ws://localhost:8002/rop");
const agent = new Agent(ws, {}, { recentKeys: Function });

const main = () => {
    let content = I.cell(_ => {
        let str = I.ifPending(agent.remotes.recentKeys(),
                              s => `Pending: ${s} ...`);
        return str || E({$tag: "i", fontSize: "80%"}, "--empty--");
    });

    E({
        $element: document.body,
        backgroundColor: "#aaa",
        margin: 40,
        font: "20px 'Avenir Next'",
        textAlign: "center",
    }, content);
};

I.use(I.cell(main));
