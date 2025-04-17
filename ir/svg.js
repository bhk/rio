import E from "./e.js";

// https://infra.spec.whatwg.org/#svg-namespace
let ESvg = E.newClass({
    $ns: "http://www.w3.org/2000/svg",
    $tag: "svg",
});

// Construct an <svg> element (with an idiosyncratic set of defaults)
//
let ESvgIcon = ESvg.newClass({
    $attrs: {
        viewBox: "0 0 100 100",
    },
    strokeWidth: 3,
    strokeLinejoin: "round",
    strokeLinecap: "round",
    fill: "currentColor",
    stroke: "currentColor",
});

// Construct a <path> element
let newPath = (attrs) =>
    ESvg({
        $tag: "path",
        $attrs: (typeof attrs == "string" ? {d: attrs} : attrs),
    });

// Construct a 100x100 SVG element from a set of paths
let newIcon = (props, ...paths) => {
    return ESvgIcon(props, paths.map(newPath));
};

export {ESvg, ESvgIcon, newPath, newIcon};
