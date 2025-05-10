// ROP/WS client for the brower environment

import * as I from "./i.js";
import * as E from "./e.js";
import { Agent } from "./rop.js";

Error.stackTraceLimit = 100;

const ws = new WebSocket("ws://localhost:8002/rop");
const agent = new Agent(ws, {}, { recentKeys: Function });

const main = () => {
    const content = I.cell(_ => {
        const str = I.ifPending(agent.remotes.recentKeys(),
                                s => `Pending: ${s} ...`);
        return str || E.Div({$tagName: "i", fontSize: "80%"}, "--empty--");
    });

    const style = {
        backgroundColor: "#aaa",
        margin: 40,
        font: "20px 'Avenir Next'",
        textAlign: "center",
    };
    E.assign(document.body, style, content);
};

I.use(I.cell(main));
