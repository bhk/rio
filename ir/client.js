// ROP/WS client for the brower environment

import {use, activate, rootCause, usePending, Pending} from "./i.js";
import {E, setProps, setContent} from "./e.js";
import {Agent} from "./rop.js";

const activatePending = (fn) => activate(() => {
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
});

setProps(document.body, {
    margin: 20,
    font: "20px 'Avenir Next'",
});

//----------------------------------------------------------------

let ws = new WebSocket("ws://localhost:8002/rop");
let agent = new Agent(ws);

let main = () => {
    let recentKeys = agent.getRemote(1);
    let [done, value] = usePending(recentKeys());
    let str = done ? value : "Pending...";
    setContent(document.body, [ String(str.length), ": ", str ]);
};

activatePending(main);
