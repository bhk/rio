
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

export { fmtTime };
