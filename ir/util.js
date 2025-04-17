
let fmtTime = function (value) {
    var n = Math.round(value);
    if (value == null || n < 0) {
        return "--";
    }
    var twoMore = function (i) { return ":" + (i < 10 ? "0" : "") + i; };
    var s = n % 60;
    var m = Math.floor(n / 60) % 60;
    var h = Math.floor(n / 3600);
    return (h > 0 ? h.toFixed(0) + twoMore(m) : m) + twoMore(s);
};

let merge = function () {
    var objects = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        objects[_i] = arguments[_i];
    }
    var obj = {};
    for (var _a = 0, objects_1 = objects; _a < objects_1.length; _a++) {
        var o = objects_1[_a];
        if (o != null) {
            for (var _b = 0, _c = Object.keys(o); _b < _c.length; _b++) {
                var name_1 = _c[_b];
                obj[name_1] = o[name_1];
            }
        }
    }
    return obj;
};

export { fmtTime, merge };
