import { use, lazy, state, Action } from "./i.js";
import { Div, assign} from "./e.js";

const newState = (value) => {
    let s = state(value);
    let set = value => new Action(_ => s.set(value));   // IMPERATIVE
    return [s, set];
};

const [number, setNumber] = newState(1);

const numberGoUp = incr =>
      setNumber(use(number) + incr);

const button = Div({
    $tagName: "input",
    $type: "button",
    $value: "Number Go Up",
    $onclick: (evt) => numberGoUp(1),
});

assign(document.body,
       { margin: 20, background: "#aaa" },
       button, Div(null, number));
