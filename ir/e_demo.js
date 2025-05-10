import { Div, assign } from "./e.js";

const E1 = Div.newClass({border: "1px solid #666", margin: "10px 0"});
const Italic = E1.newClass({$tagName: "i"});
const Gray = E1.newClass({background: "#eee"});

assign(
    document.body,
    { margin: 20 },
    E1(null, "E1 = { border: ...}"),
    Italic(null, "This", " is", " an <I> element"),
    Gray(null, "Gray = E1 + { background: #eee }"));
