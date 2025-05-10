import { Div, assign } from "./e.js";
import * as I from "./i.js";

window.I = I;
const {use, lazy} = I;

//----------------------------------------------------------------
// i.js mods

class Action {
    constructor(f) { this.f = f; }
}

const perform = (action) => setTimeout(action.f, 0);

const newState = (value) => {
    let s = I.state(value);
    let set = value => new Action(_ => s.set(value));   // IMPERATIVE
    return [s, set];
};


//----------------------------------------------------------------
// e.js mods
//
//   $tag, $ns : special
//   $onEVENT  : event handlers
//   $ATTR     : elements attributes
//   PROP      : CSS property

let oldToNew = (props) => {
    let ep = {};
    let $events = ep.$events = {};
    for (let [k,v] of Object.entries(props)) {
        if (k.slice(0,3) == "$on") {
            ep[k] = (fn => _ => perform(fn()))(v);
        } else {
            ep[k] = v;
        }
    }
    return ep;
};

const NewElem = Elem => {
    let F = (props, ...content) => Elem(oldToNew(props), ...content);
    F.newClass = (props) => {
        let OldE = Elem.newClass(oldToNew(props));
        return NewElem(OldE);
    };
    return F;
};

const Elem = NewElem(Div);

export {
    Elem,
    assign,
    newState,
    use,
    lazy
};
