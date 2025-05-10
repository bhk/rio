import E from "./e.js";
import {state} from "./i.js";
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

});

let controls = [
    "Drag boxes to test. Box background & border colors reflect drag states.",
    "Drag to left of frame & then back in.",
];

log("Note: Yellow background => being dragged; red => error");

let newBox = (left) => {
    let iclass = state(null);
    let e = Box({
        $classList: iclass,
        left: left,
        top: 150,
    }, "Drag me");
    let style = e.style;

    // For every "start" there should be exactly one "stop".
    //
    let testAndSetClass = (expected, newClass) => {
        if (iclass.peek() != expected) {
            log("Error: class = " + iclass.peek() + ", expected " + expected);
        }
        iclass.set(newClass);
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
            testAndSetClass(null, "drag");
            dragX = dragY = 0;
        },

        dragStop: (isDrop) => {
            style.transform = "";
            testAndSetClass("drag", null);
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
