import {E, setContent} from "./e.js";
import {handleDrag, listen} from "./drag.js";
import Exposer from "./exposer.js";

let Top = E.set({
    backgroundColor: "#eee",
    font: "16px Arial",
    height: 1500,
    width: 1500,
    padding: 20,
    userSelect: "none",
    backgroundImage:
    "linear-gradient(to right, rgb(0 0 0 / 15%) 2%, rgb(0 0 0 / 0%) 4% 96%, rgb(0 0 0 / 15%) 98%)," +
        "linear-Gradient(rgb(0 0 0 / 15%) 2%, rgb(0 0 0 / 0%) 4% 96%, rgb(0 0 0 / 15%) 98%)",
    backgroundSize: "150px 150px",
    contain: "content",
});

let Box = E.set({    fontSize: 8,
    touchAction: "manipulate",
    position: "absolute",
    boxSizing: "border",
    border: "5px solid black",
    borderRadius: 5,
    userSelect: "none",
    textAlign: "center",
    padding: 3,
    backgroundColor: "#ddd",

    "&.state1": { backgroundColor: "#ee8" },    /* being dragged */
    "&.moved": { borderColor: "blue" },         /* has moved since "start" */
    "&.error": { backgroundColor: "#f00f" },    /* invalid state */
});

let StatsTable = E.set({
    /* font: "12px Arial", */
    borderCollapse: "collapse",
    position: "absolute",
    top: 60,
    left: 25,
});

let StatsTH = E.set({
    $tag: "th",
    border: "2px solid #ccc",
});

let StatsTD = E.set({
    $tag: "td",
    whiteSpace: "nowrap",
    overflow: "hidden",
    width: "4em",
    border: "2px solid #ccc",
});

let pageFromClient = (r) => {
    return {
        left: r.left + window.scrollX,
        top: r.top + window.scrollY,
        width: r.width,
        height: r.height,
    };
};

//----------------------------------------------------------------
// Buttons & Stats
//----------------------------------------------------------------

let boxes = [
    Box({left: 100, top: 150, width: 50, height: 50}, E(null, "Drag me")),
    Box({left: 200, top: 150, width: 200, height: 300}, E(null, "Drag me")),
];

let statsShown = false;
let showStats = () => {
    if (statsShown) {
        return;
    }
    statsShown = true;
    let SE = document.scrollingElement;
    let VV = window.visualViewport;

    let statsTable = StatsTable(null);

    let addStatsLine = (desc, keys, obj) => {
        keys.forEach( (key) => {
            let td = StatsTD();
            let update = () => {
                td.innerText = (typeof obj == "function"
                                ? obj(key)
                                : obj[key]);
                requestAnimationFrame(update);
            };
            update();

            let row = E({$tag: "tr"}, [
                StatsTH(null, desc + "." + key),
                td,
            ]);
            statsTable.appendChild(row);
        });
    };

    // Display different ways of computing viewport

    addStatsLine("window", ["scrollX", "scrollY"], window);
    addStatsLine("SE", ["clientWidth", "clientHeight"], SE);
    if (VV) {
        addStatsLine("VV", ["pageLeft", "pageTop", "width", "height"], VV);
    }

    boxes[1].appendChild( statsTable );
};

// This rectangle limits the region to be exposed

let limit = E({
    width: 1400,
    height: 1400,
    border: "2px solid #8cc",
});

setContent(document.body, Top(null, [
    E({$tag: "p"}, E({
        $tag: "input",
        $attrs: {type: "button", value: "Stats"},
        $events: {click: showStats},
    })),
    limit,
    boxes,
]));

let limitRect = pageFromClient(limit.getBoundingClientRect());

//----------------------------------------------------------------
// Draggable boxes
//----------------------------------------------------------------

let round = x => Math.floor(x*10) / 10;
let fmtTopLeft = r => "(" + round(r.left)  +"," + round(r.top) + ")";
let toNum = (str) => Number(str.match(/[0-9\.]*/)[0]);
let pxAdd = (px, n) => (toNum(px) + n) + 'px';

let makeDraggable = (e) => {
    let initialClass = e.className;
    let style = e.style;
    let state = 0;

    let label = e.firstElementChild;

    // For every "start" there should be exactly one "stop".
    //
    let checkAndSetState = (expected, newState) => {
        let old = state;
        state = newState;
        if (old != expected) {
            e.className = initialClass + " box error";
            console.log("state = " + state + ", expected " + expected);
        } else {
            e.className = initialClass + " box state" + state;
        }
    };

    let dragX = 0;
    let dragY = 0;
    let setDrag = (dx, dy) => {
        dragX = dx;
        dragY = dy;
        style.transform = "translate(" + dx + "px, " + dy + "px)"
    };

    let exposer;

    let dragTarget = {
        dragStart: () => {
            checkAndSetState(0, 1);
            dragX = dragY = 0;
            exposer = Exposer(
                e, limitRect, 10,
                (dx, dy) => setDrag(dragX + dx, dragY + dy));
            exposer(true);
        },

        dragStop: (isDrop) => {
            style.transform = "";
            exposer(false);
            checkAndSetState(1, 0);
            if (isDrop) {
                style.left = pxAdd(style.left, dragX);
                style.top = pxAdd(style.top, dragY);
            }
        },

        dragMove: (dx, dy, event) => {
            e.classList.add("moved");
            setDrag(dx, dy);
            let client = e.getBoundingClientRect();
            let page = pageFromClient(client);

            label.innerHTML = "Client:<br>" + fmtTopLeft(client) + "<br>Page:<br>" + fmtTopLeft(page);

            exposer(true);
        },
    };

    handleDrag(e, dragTarget);
};

boxes.forEach(makeDraggable);
