// Number Go Up
import { assign, Elem, newState, use, lazy } from "./goup.js";

const [number, setNumber] = newState(1);

const numberGoUp = incr =>
      setNumber(use(number) + incr);

assign(
    document.body,
    { margin: 25, fontSize: 50 },
    Elem({
        $tagName: "input",
        $type: "button",
        $value: "Number Go Up!",
        $onclick: _ => numberGoUp(1),
    }),
    Elem({}, number),
);
