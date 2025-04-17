import {E, setContent} from "./e.js";

let E1 = E.set({border: "1px solid #666", margin: 5});
let E2 = E1.set({background: "#eee"});
let E3 = E2.set({$tag: "i"})

setContent(document.body, [
    E1(null, "E2 { border: ...}"),
    E2(null, "E1 { background: #eee }"),
    E3(null, "This", " is", " an <I> element"),
]);
