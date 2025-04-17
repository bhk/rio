import "./mockdom.js";
import newGrid from "./grid.js";

const columns = [
    {key: null, width: 26},
    {key: "0", width: 220, sort: "up"},
    {key: "1", width: 120, fmt: s => "[" + s + "]"}
];

const db = [
    ["A0", "A1"],
    ["B0", "B1"],
];

const fields = {
    "0": {label: "Name"},
    "1": {label: "Artist"},
};

const rowClicked = () => {};

const e = newGrid(columns, fields, db, rowClicked);
