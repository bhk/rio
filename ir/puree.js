//import {} from "./intern.js";

const D = document;

const doc = {
    tag: "div",
    css: { backgroundColor: "#eee" },
    content: [
        {tag: "i",
         css: {backgroundColor: "#fcc"},
         content: ["hi"]
        },
    ],
};


// 1

const newNode = (value) =>
      typeof value == "string" ? D.createTextNode(value) : newElem(value);

const newElem = (obj) => {
    const e = D.createElement(obj.tag);
    for (const [k, v] of Object.entries(obj.css)) {
        console.log(k, v);
        e.style[k] = v;
    }
    for (const i of obj.content) {
        e.appendChild(newNode(i));
    }
    return e;
};


D.body.appendChild(newElem(doc));

console.log("puree!");
