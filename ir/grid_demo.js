import {use, wrap, newState, getCurrentCell} from "./i.js";
import E from "./e.js";
import {run, log} from "./demo.js";
import newGrid from "./grid.js";

// Returns conduit holding input field contents.
//
const newInput = (style, text) => {
    const ivalue = newState("");
    const e = E({
        ...style,
        $tag: "input",
        $attrs: {
            type: "text",
            placeholder: text,
        },
        $events: {
            input: (evt) => (ivalue.set(e.value), true),
        }
    });
    return {e, value: () => use(ivalue)};
};

//----------------------------------------------------------------
// Data
//----------------------------------------------------------------

const sampleEntries = [
    ["Play that Funky Music", "Wild Cherry",
     "Wild Cherry", "3:18", "1976", "Rock", "0"],
    ["Maybe the People Would Be the Times or Between Clark and Hilldale",
     "Love", "Forever Changes", "3:35", "1967", "Rock", "0"],
    ["Relative Ways", "...And You Will Know Us By The Trail Of Dead",
     "Source Tags & Codes", "4:03", "2002", "Alternative", "0"],
    ["Feathered Indians", "Tyler Childers",
     "Purgatory", "3:45", "2017", "Country", "0"],
    ["Oxford Town", "Bob Dylan",
     "The Freewheelin' Bob Dylan", "1:50", "1963", "Folk", "0"],
    ["Timeless Melody", "The La's",
     "The La's", "3:02", "1990", "Rock", "0",],
    ["The Girl On The Billboard", "Del Reeves",
     "The Original UA Hits", "2:43", "1965", "Country", "0"],
];

const fields = {
    "0": {label: "Name"},
    "1": {label: "Artist"},
    "2": {label: "Album"},
    "3": {label: "Time", align: "right"},
    "4": {label: "Year", align: "right"},
    "5": {label: "Genre"},
    "6": {label: "♡", align: "center"},
};

const columns = [
    {key: null, width: 26},
    {key: "0", width: 220, sort: "up"},
    {key: "1", width: 120, sort: "down"},
    {key: "2", width: 120},
    {key: "3", width:  40},
    {key: "4", width: 140},
    {key: "5", width:  90},
    {key: "6", width:  24},
];

const itemCount = newState(sampleEntries.length);

run(_ => {
    let rowClicked = (row) => log("Click: row " + row);

    let entries = newInput({}, "# Entries...");
    let controls = [
        entries.e,
        "Verify: Cannot resize first column; can resize others.",
        "Verify: On mouseup, column sizes are updated",
        "Verify: Scrolling (set # entries high)",
        "Verify: Click reports row number (and when scrolled)",
    ];

    let db = wrap(_ => {
        const a = [];
        const k = Number(entries.value() || 30) || 0;
        const kSample = sampleEntries.length;
        for (let i = 0; i < k; ++i) {
            a.push(sampleEntries[i % kSample]);
        }
        return a;
    });
    let subject = newGrid(columns, fields, db.cell(), rowClicked);

    return {subject, controls};
});
