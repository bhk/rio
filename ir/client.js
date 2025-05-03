// ROP/WS client for the brower environment

import {use, cell, rootCause, usePending, Pending} from "./i.js";
import E from "./e.js";
import {Agent} from "./rop.js";

const logPending = (fn) => {
    try {
        fn();
    } catch (e) {
        let cause = rootCause(e);
        if (cause instanceof Pending) {
            console.log("Pending:", cause.value)
        } else {
            console.log(e);
            throw e;
        }
    }
};

//----------------------------------------------------------------

let ws = new WebSocket("ws://localhost:8002/rop");
let agent = new Agent(ws);

let main = () => {
    let recentKeys = agent.getRemote(1);
    let [done, value] = usePending(recentKeys());
    let str = done ? value : "Pending...";
    E({
        $element: document.body,
        margin: 20,
        font: "20px 'Avenir Next'",
    },
      String(str.length), ": ", str);
};

use(cell(_ => logPending(main)));
