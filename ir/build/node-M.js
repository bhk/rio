import assert from 'assert';
import {open} from 'fs/promises';

let target = process.env.TestJS_MT;
assert(target);
let depfilename = target + ".d";

let handle = await open(depfilename, 'w');

export async function resolve(specifier, context, defaultResolve) {
    let o = await defaultResolve(specifier, context, defaultResolve);
    let m = o.url.match(/^file:\/\/(.*)/);
    if (m) {
        let [_, file] = m;
        await handle.write(target + ": " + file + "\n"
                           + file + ":\n");
    }
    return o;
}
