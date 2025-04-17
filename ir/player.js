// player.js: Browser "main" script (takes ownership of BODY)

import kfat from "../kfat/logparse/.crank/out/kfat.js";
import newGrid from "./grid.js";
import {E, setProps, setContent} from "./e.js";
import {newState, use, activate} from "./i.js";
import {fmtTime, merge} from "./util.js";

// Returns conduit holding input field contents.
//
const newInput = (props) => {
    const textState = newState("");
    const e = E({
        $tag: "input",
        $events: {
            input: (evt) => (textState.set(e.value), true),
        },
        ...props,
        $attrs: {
            type: "text",
            ...(props.attrs || {}),
        },
    });

    const text = () => use(textState);
    return [e, text];
};

//----------------------------------------------------------------
// Data
//----------------------------------------------------------------

const MAXSONGS = 12000;

const dir = (name) => (name.match(/(.*\/).*/) || [1,"."])[1];

const songs = [];
kfat.forEach(
    (logfile) => {
        const sourceDir = dir(logfile.source);
        logfile.logs.forEach(
            (log) => {
                const file = log.props.file;
                const path = sourceDir + file;
                log.clips.forEach(
                    (rec) => {
                        rec.path = path;
                        rec.file = file;
                        if (songs.length < MAXSONGS) {
                            songs.push(rec);
                        }})})});

const fields = {
    "desc": {label: "Title"},
    "length": {label: "Time", align: "right", fmt: fmtTime},
    "file": {label: "File"},
    "start": {label: "Offset", align: "right", fmt: fmtTime},
};

const columns = [
    {width:  26},
    {width: 420, key: "desc"},
    {width:  50, key: "length"},
    {width:  60, key: "start"},
    {width: 300, key: "file"},
];

function filterSongs(text) {
    if (text == "") {
        return songs;;
    }

    const caseFlag = text.match(/[A-Z]/) ? "" : "i";
    const re = new RegExp(text, caseFlag);

    const db = [];
    songs.forEach( (song) => {
        if (song.desc.match(re)) {
            db.push(song);
        }
    });
    return db;
}

const audioElem = E({
    $tag: "audio",
    $attrs: { controls: "controls" },
    width: 480,
    height: 31,
    margin: 8,
});

//----------------------------------------------------------------
// Search input control
//----------------------------------------------------------------

let [srchElem, searchText] = newInput({
    position: "absolute",
    boxSizing: "border-box",
    left: 510,
    top: 13,
    width: 160,
    height: 21,
    $attrs: {
        type: "search",
        placeholder: "Search...",
    },
});

//----------------------------------------------------------------
// Grid
//----------------------------------------------------------------

const db = wrap(_ => filterSongs(searchText())).cell();

function rowClicked(n, _db) {
    const db = use(_db);
    const song = db[n];
    const file = song.path;
    const src = encodeURIComponent(song.path).replace(/%2[Ff]/g, "/");
    if (src != audioElem.getAttribute("src")) {
        audioElem.setAttribute("src", src);
    }
    audioElem.play().then(_ => { audioElem.currentTime = song.start });
}

const main = () => {
    // TODO: newGrid takes opts; opts include `style`
    const gridElem = newGrid(columns, fields, db, rowClicked);
    gridElem.style.top = "50px";
    return [audioElem, srchElem, gridElem];
}

//----------------------------------------------------------------
// Top
//----------------------------------------------------------------

activate(() => {
    setProps(document.body, {
        margin: 0,
        background: "#f2f3f4",   // #f2f3f4 is Chrome audio controls BG
        overflow: "hidden",
    });
    setContent(document.body, main());
});
