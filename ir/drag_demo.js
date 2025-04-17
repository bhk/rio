import E from "./e.js";
import {newState} from "./i.js";
import {run, log} from "./demo.js";
import {handleDrag, listen} from "./drag.js";

let toNum = (str) => Number(str.match(/-?[0-9\.]*/)[0]);
let pxAdd = (px, n) => (toNum(px) + n) + 'px';

let Box = E.newClass({
    touchAction: "none",
    position: "absolute",
    boxSizing: "border",
    width: 50,
    height: 50,
    border: "5px solid black",
    borderRadius: 5,  /* too twee? */
    userSelect: "none",
    textAlign: "center",
    padding: 3,
    backgroundColor: "#ddd",

    "&.state1": { backgroundColor: "#ee8", },    /* being dragged */
    "&.error": { backgroundColor: "#f00", },     /* invalid state */
});

let controls = [
    "Drag boxes to test. Box background & border colors reflect drag states.",
    "Drag to left of frame & then back in.",
];

log("Note: Yellow background => being dragged; red => error");

let newBox = (left) => {
    let iclass = newState(null);
    let e = Box({
        left: left,
        top: 150,
        $attrs: {
            class: iclass,
        },
    }, "Drag me");
    let style = e.style;
    let state = 0;

    // For every "start" there should be exactly one "stop".
    //
    let checkAndSetState = (expected, newState) => {
        let old = state;
        state = newState;
        if (old != expected) {
            iclass.set("error");
            log("Error: state = " + state + ", expected " + expected);
        } else {
            iclass.set("state" + state);
        }
    };

    let dragX = 0;
    let dragY = 0;
    let setDrag = (dx, dy) => {
        dragX = dx;
        dragY = dy;
        style.transform = "translate(" + dx + "px, " + dy + "px)"
    };

    let dragTarget = {
        dragStart: () => {
            checkAndSetState(0, 1);
            dragX = dragY = 0;
        },

        dragStop: (isDrop) => {
            style.transform = "";
            checkAndSetState(1, 0);
            if (isDrop) {
                style.left = pxAdd(style.left, dragX);
                style.top = pxAdd(style.top, dragY);
            }
        },

        dragMove: (dx, dy, event) => {
            setDrag(dx, dy);
        },
    };

    handleDrag(e, dragTarget);
    return e;
};

run(_ => {
    let subject = [ newBox(100), newBox(200) ];
    return {subject, controls, frameStyle: { height: 600 } };
});
