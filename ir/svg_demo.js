//
// Demonstrate svg module, and demo specific icons used by game.js.
//

import E from "./e.js";
import { ESvg, newPaths } from "./svg.js";

// Construct an <svg> element with an idiosyncratic set of defaults
//
let Icon = ESvg.newClass({
    $viewBox: "0 0 100 100",
    strokeWidth: 3,
    strokeLinejoin: "round",
    strokeLinecap: "round",
    fill: "currentColor",
    stroke: "currentColor",
});

let newIcon = (props, ...paths) =>
    Icon(props, newPaths(...paths));

let demos = {};

//----------------------------------------------------------------
// Shuffle
//----------------------------------------------------------------

demos.Shuffle = newIcon(null,
    "M65,48 l22,15 l-22,15 z",
    { $d: "M75,63 h-40 a15,15 0 0,1 0,-30 h10",
      "$stroke-width": "9",
      $fill: "none" });

//----------------------------------------------------------------
// Play
//----------------------------------------------------------------

demos.Play = newIcon(null, "M80,50 L30,80 L30,20 Z");

//----------------------------------------------------------------
// Star
//----------------------------------------------------------------

// "canned" star path
demos.Star = newIcon(null, "M50,18L71,81L17,42L83,42L29,81Z");

if (true) {
    // generate 5-point star path
    let scale = 0.7;
    let getXY = (angle, r) =>
        Math.round(50 + r*Math.sin(angle)) + ","
        + Math.round(50 + scale*4.5 - r*Math.cos(angle));
    let a = [...Array(6).keys()].map(n => getXY(Math.PI/1.25 * n, scale*50));
    let starPath = "M" + a.join("L") + "Z";
    demos.algoStar5 = newIcon(null, starPath);
}

if (true) {
    // generate 10-point path (suitable for highlighting stroke)
    let scale = 0.7;
    let getXY = (angle, r) =>
        Math.round(50 + r*Math.sin(angle)) + ","
        + Math.round(50 + scale*4.5 - r*Math.cos(angle));
    let a = [...Array(11).keys()].map(n =>
        getXY(Math.PI/5 * n, scale*(50 - 30.9*(n&1))));
    let starPath = "M" + a.join("L") + "Z";
    demos.algoStar10 = newIcon({ fill: "#888" }, starPath);
}

//----------------------------------------------------------------
// Chat Icon
//----------------------------------------------------------------

// Return [x,y] which is `r` units from [x0,y0] in the direction of [x1,y1]
let toward = ([x0, y0], [x1, y1], r) => {
    let [dx, dy] = [x1-x0, y1-y0];
    let p = r/(dx**2 + dy**2)**0.5;
    return [x0 + p*dx, y0 + p*dy].map(Math.round);
};

let roundedPath = (radius, pathOpen) => {
    let path = [...pathOpen, pathOpen[0]];
    let data = [];
    let xprev, yprev;
    for (let ii = 0; ii < path.length-1; ++ii) {
        let [x, y, rm, dir] = path[ii];
        if (rm) {
            let r = rm*radius;
            let [x1, y1] = toward([x, y], path[ii-1], r);
            let [x2, y2] = toward([x, y], path[ii+1], r);
            // Using "arcto" is more complex and bulky, and no better here...
            //   [x1, y1, "A", r, r, 0, 0, (dir ? 1 : 0), x2, y2]
            data.push([x1, y1, "Q", x, y, x2, y2].join(" "));
        } else {
            data.push([x, y].map(Math.round).join(" "));
        }
        xprev = x;
        yprev = y;
    }
    return "M " + data.join(" L") + " Z";
};

let xlat = ([x, y, r, sweep]) => [12+x*2.5, 70-y*2.5, r && r*2.5, sweep];

let d = roundedPath(8, [
    [6, -8],
    [18, 0],
    [30, 0, 1],
    [30, 20, 1],
    [0, 20, 1],
    [0, 0, 1],
    [9, 0],
].map(xlat));

d = d.replace(/ *([A-Za-z]) */g, "$1");

demos.Chat = newIcon({ fill: "none", strokeWidth: 8 }, d);

//----------------------------------------------------------------

let TH = E.newClass({ $tagName: "th", padding: "0 2em" });
let TD = E.newClass({ $tagName: "td", width: 120, height: 120,
                      border: "3px solid #ccc" });

let tbl = E({ $tagName: "table" },
            Object.entries(demos).map( ([name, elem]) =>
                E({ $tagName: "tr" },
                  TH(null, name),
                  TD(null, elem))));

document.body.appendChild(tbl);
