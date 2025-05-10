// grid.js

import E from "./e.js";
import {handleDrag} from "./drag.js";
import {lazy, use, state, onDrop} from "./i.js";

const MINWIDTH = 40;
const rowHeight = 22;

//--------------------------------------------------------------
// Element styling classes
//--------------------------------------------------------------
//
// Sizing: The top-level element, GridView.e, fills its containing block.
//
// Anchoring: We want to be able to move all items in a column to the left
// or right (and other columns to the right) by setting a single attribute
// (or a small finite number of them), and we want to move *all* cells up
// and down (scrolling).
//
// We do this with grid layout: each cell is a child of the grid, and has
// its own col/row position.  In CSS grid layout, rows are not DOM elements.
// We create "DataRow" elements as grid cells that span all columns to color
// the background (for even/odd and selection) and provide pointer events.
// Auto-placement is not used (it doesn't work with sparse on-demand
// population of the grid, or with the DataRow elements spanning all
// columns), so every data cell has a custom `grid-area` style.
//
// Scrolling: Data cells should scroll horiz & vert, but headers should move
// only horiz.  Therefore, we have *two* grids (siblings), one for data
// cells and one for headers.  The data grid is `overflow: scroll` and we
// use JS to update the header grid's horizontal position to match.
//
//     Absolute positioning would probably work as well as (better then?)
//     grid layout.  Each cell could be a child of a column element, and row
//     elements being children of the first column, and columns being a
//     child of a parent "grid" (which can be scrolled).
//

const GridBase = E.newClass({
    display: "grid",
    gridAutoRows: rowHeight,
    font: "12px -apple-system, Helvetica, 'Lucida Grande', sans-serif",
});

const DataGrid = GridBase.newClass({
    $class: "DataGrid",
    overflow: "scroll",         // scroll up/down (just data cells, not headers)
    position: "absolute",
    top: rowHeight + 2,
    bottom: 0,
    left: 0,
    right: 0,
    // paint odd/even pattern to data grid background
    // Safari has problems with background-attachment
    backgroundImage: "linear-gradient(transparent 50%, #0000000c 50%)",
    backgroundSize: "auto " + rowHeight * 2 + "px",
    backgroundAttachment: "local", // scroll with contents
});

const DataCell = E.newClass({
    $class: "DataCell",
    padding: "3px 5px",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    pointerEvents: "none",
});

// HdrGrid consists of one row, plus a single pixel of border above and
// below.  It contains one HdrCell for each column.
//
//  - A divider line appears at the right edge of each header cell (in the
//    rightmost pixel column of each grid cell).
//  - The divider line (and the few pixels left and right of it) is
//    "draggable" when its column it resizable.
//  - The header text must be clipped => "overflow: hidden" on some element
//    that also restricts height and width.
//  - The draggable area of a cell divider extends beyond the grid cell into
//    the next grid cell to the right (so it must be layered above the cell
//    to the right).
//

const HdrGrid = GridBase.newClass({
    $class: "HdrGrid",
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    border: "1px solid #e6e6e6",  // this makes HdrGrid two pixels taller than one row
    borderWidth: "1px 0",
    background: "white",
});

const HdrCell = E.newClass({
    $class: "HdrCell",
    position: "relative",
    overflow: "hidden",
});

// "sort" class => header is primary sort key
// "up" class => sort direction is ascending
//
const HdrLabel = E.newClass({
    $class: "HdrLabel",
    padding: "4px 5px 2px 4px",
    whiteSpace: "nowrap",
    textOverflow: "none",
    position: "relative",
    background: "white",
    left: 0,
    // sort keys are displayed slightly boldfaced
    "&.sort": {
        fontWeight: "600",
        paddingRight: 18,
    },
    // "::after" pseudo-element contains up/down indicator
    "&.sort::after": {
        position: "absolute",
        right: 3,
        content: "'\u25bc'",  // 0x25BC = Black down-pointing triangle: ▼
        color: "#aaa",
        fontWeight: "300",
        background: "inherit",
        width: 15,

        textAlign: "center",
        paddingTop: 2,
        fontSize: "90%",
    },
    "&.sort.up::after": {
        content: "'\u25B2'",  // 0x25B2 = Black up-pointing triangle: ▲
        paddingTop: 0,
    }
});

const Divider = E.newClass({
    $class: "Divider",
    position: "absolute",

    // The content area of this element is a thin vertical bar.
    background: "#e6e6e6",
    width: 1,
    right: -4,
    top: 0,
    height: 18,

    // The border is invisible (white-on-white) but part of the clickable
    // area.  The wider border on the right seems necessary for a "balanced"
    // look and feel to the mouseover events.
    borderWidth: "2px 4px 2px 3px",
    borderStyle: "solid",
    borderColor: "white",
});

const DragDivider = Divider.newClass({
    $class: "DragDivider",
    cursor: "col-resize",
});

//--------------------------------------------------------------
// GridTop
//--------------------------------------------------------------

const GridTop = E.newClass({
    $class: "GridTop",
    overflow: "hidden",
    background: "white",
    // fill parent
    position: "absolute",
    right: 0,
    bottom: 0,
    left: 0,
    top: 0,
});

const newCell = (value, fmt, align, rowIndex, colIndex) => {
    // console.log("gridArea: " + (rowIndex+1) + " / " + (colIndex+1));
    return DataCell({
        textAlign: align || "",
        gridArea: (rowIndex+1) + " / " + (colIndex+1),
    }, fmt ? fmt(value) : value);
};

const createGridCells = (db, columns, fields) => {
    const o = [];

    db.forEach((rec, rowIndex) => {
        // cells for each column
        columns.forEach( (c, colIndex) => {
            if (c.key) {
                const value = rec[c.key];
                const {fmt, align} = fields[c.key];
                o.push(newCell(value, fmt, align, rowIndex, colIndex));
            }
        });
    });
    return o;
};

// Note: column header elements must appear in reverse order so that
// dragger elements stack correctly.
//
const newColHeader = (fields, colInfo, colIndex) => {
    const {key, width, sort} = colInfo;
    const {label, align} = (key ? fields[key] : {});

    let colWidth, eDivider;
    if (key == null) {
        eDivider = Divider();
        colWidth = width;
    } else {
        eDivider = DragDivider();
        colWidth = state(width);
        let dropWidth = width;
        const dereg = handleDrag(eDivider, {
            dragStart() {},
            dragMove(dx, dy, event) { colWidth.set(dropWidth + dx) },
            dragStop(isDrop) { if (isDrop) dropWidth = colWidth.peek(); },
        });
        onDrop(dereg);
    }

    // header label
    const eLabel = label &&
          HdrLabel({
              textAlign: (align ? align : ""),
              fontWeight: (sort ? "600" : ""),
              $classList: sort ? "sort " + sort : "",
          }, label);

    const hdrCell = HdrCell({gridArea: "1 / " + (colIndex+1)},
                            eLabel, eDivider);

    return [hdrCell, colWidth];
};

// columns = array of {key, width, sort}
//    This describes which columns are displayed and how.
//      key: index into `fields` and `db` rows
//      width: displayed column width, in pixels.
//      sort: null | "up" | "down"  (visual indicator of sorting)
//
// fields = map of key -> {label, align}
//    This describes contents of the database.
//      label: Text for the column header.
//      align: "right" | "center" | null; how column & header is aligned
//
// db = array of rows;  row = key -> text
//
const newGrid = (columns, fields, db, fnRowClicked, eprops) => {

    // GridTop
    //    DataGrid
    //      DataCell ...
    //    HdrGrid
    //      HdrCell ...
    //

    // Construct column headers & get (resizing) widths for each
    const widths = [];
    const headers = columns.map((colInfo, colIndex) => {
        const [cell, width] = newColHeader(fields, colInfo, colIndex);
        widths.push(width);
        return cell;
    }).reverse();

    // This value describes the widths of all columns
    const gtc = lazy(_ => widths.map(w => use(w)+"px").join(" ") + " 1fr");

    const hdrGrid = HdrGrid({gridTemplateColumns: gtc}, headers);

    const dataGrid = DataGrid({
        gridTemplateColumns: gtc,
        $onscroll: () => {
            hdrGrid.style.left = -dataGrid.scrollLeft + "px";
        },
        $onmousedown: (evt) => {
            let rowLine = Math.floor((evt.offsetY + evt.target.scrollTop)
                                     / rowHeight);
            if (rowLine >= 0) {
                if (fnRowClicked) {
                    fnRowClicked(rowLine, db);
                }
            }
        },
    }, lazy(_ => createGridCells(use(db), columns, fields)));

    return GridTop(eprops, dataGrid, hdrGrid);
};

export default newGrid;
