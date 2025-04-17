"use strict";


const fmtTime = (value: number) => {
    const n = Math.round(value);;
    if (value == null || n < 0) {
        return "--";
    }

    const twoMore = (i: number) => ":" + (i < 10 ? "0" : "") + i;

    const s = n % 60;
    const m = Math.floor(n/60) % 60;
    const h = Math.floor(n/3600);

    return (h>0 ? h.toFixed(0) + twoMore(m) : m) + twoMore(s);
};


const merge = (...objects: any[]) => {
    let obj = {};
    for (const o of objects) {
        if (o != null) {
            for (const name of Object.keys(o)) {
                obj[name] = o[name];
            }
        }
    }
    return obj;
};


module.exports = {fmtTime, merge};
