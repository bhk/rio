import * as I from "./i.js";
import { getTime, lazyTime } from "./time.js";
import { Div, assign } from "./e.js";

// Reactive window.location.hash
//
const getHash = () => {
    window.addEventListener('hashchange', I.getInvalidateCB(), {once: true});
    return window.location.hash;
};

// Reactive viewport dimensions
//
const getWindowSize = () => {
    window.addEventListener('resize', I.getInvalidateCB(), {once: true});
    return [window.innerWidth, window.innerHeight];
};

const hashCount = _ => +(getHash() || "#").slice(1);

// Exercise $tagName (creation parameter) and $href (attribute)
const A = Div.newClass({$tagName: "a"});

// Exercise dynamic content, attribute ($href), and CSS properties
assign(
    document.body, {
        margin: 20,
        background: "#eee"
    },
    A({ $href: I.lazy(_ => "#" + (1 + hashCount())) },
      "Go..."),
    Div({ margin: I.lazy(hashCount) },
        "Hash:  ", I.lazy(getHash)),
    Div(null, I.lazy(_ => Date(getTime()))),
    Div(null, I.lazy(_ => { const wh = getWindowSize();
                            return ["Size: ", wh[0], " x ", wh[1]] }))
);
