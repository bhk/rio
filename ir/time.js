import * as I from "./i.js";

const roundOffset = (value, period, offset) =>
      Math.floor((value - offset) / period) * period + offset;

// getTime(PERIOD, OFFSET) => time rounded down to most recent "tick", where
//     tick = N * PERIOD + OFFSET.  Arguments are optional; PERIOD defaults
//     to 1000, OFFSET to 0.  All values are in milliseconds.
//
const getTime = (period, offset) => {
    period ??= 1000;
    offset ??= 0;
    const t = Date.now();
    const value = roundOffset(t, period, offset);
    setTimeout(I.getInvalidateCB(), value + period - t);
    return value;
};

// lazyTime(...) => thunk that evalutes to getTime(...)
//
const lazyTime = I.defer(getTime);

export {
    getTime,
    lazyTime,
};
