//----------------------------------------------------------------
// Auto-scroll
//----------------------------------------------------------------
//
// ====  Browser APIs & Behavior  ====
//
// Some resources:
//
//   developer.mozilla.org/en-US/docs/Web/API/Visual_Viewport_API
//   CSSOM View Module : drafts.csswg.org/cssom-view/
//   CSS Overflow Module Level 3 : drafts.csswg.org/css-overflow-3/
//   CSS Device Adaptation Module : www.w3.org/TR/css-device-adapt-1/
//   CSS2.2 : drafts.csswg.org/css2/
//   Visual Viewport API : wicg.github.io/visual-viewport/
//
// ... but beware, much of what is written is incoherent.  CSS2 defined the
// viewport, quite reasonably, as the rectangle of the document displayed to
// the user.  Unfortunately, it attached layout rules to that notion,
// specifically block element widths and the positioning of "fixed" elements.
// This became a problem when mobile browsers came along and, for good
// usability reasons, supported zooming, panning, and resizing (e.g. when
// on-screen keyboards appear) in a way that did not modify document layout or
// move fixed elements.  They effectively redefined CSS2 layout so that it was
// based on a make-believe viewport, generally known as the "layout viewport",
// while the actual viewport (the area actually displayed) is known as the
// "visual viewport".  Then we have the "Device Adaptation Module", which
// confoundingly uses the term "actual viewport" for the layout viewport(!)
// and introduces another term, "initial viewport" (which is also not a
// viewport).  Other W3C documents, like the CSSOM View Module, refer to
// "viewport" quite ambiguously.
//
// The standards are far out of sync with implementations.
//
// APIs:
//
//   window.scroll{X,Y}
//   window.page{X,Y}Offset
//   window.{scroll,scrollTo}(x, y)
//   document.scrollingElement.scroll{Left,Top}
//   document.scrollingElement.{scroll,scrollTo}()
//
//      These all seem to get/set the same values; call them "WX" and "WY".
//
//      In some experimentation with Safari for iOS, these properties reflect
//      the page coordinates of the visual viewport (even when in pinch zoom!)
//      except that they are always integers.  When zoom scale is < 1, reading
//      WY after setting it will often yield a slightly different value.
//
//      In Chrome for Android, when in pinch zoom mode, these do not match the
//      location of the visual viewport and cannot be used to move it.
//
//      Mozilla also rounds these values to integers, but Chrome "rounds" to
//      multiples of scroll factor (1.25, 1.5, ...).  Plan for the worst.
//
//   window.inner{Width,Height}
//   window.inner{Width,Height}
//
//      As with WX and WY, these values reflect the visual viewport in Safari
//      but not in Chrome [as of 9-Apr-2021].  It is documented as including
//      the scrollbar width (if there is one), so on desktop browers
//      document.scrollingElement.clientWidth would be better.
//
//   window.visualViewport.{pageLeft,pageTop,width,height}
//
//      This provides a way to get the size and position of the visual
//      viewport, otherwise unavailable in Chrome/Android, but does not provide
//      a way to modify (e.g. scroll) it.  Mozilla does not (yet) support this.
//
//   element.getBoundingClientRect().{top,left,width,height}
//
//      Supported on Safari, Chrome, and Mozilla.  These "client" coordinates
//      are pretty useless since in Chrome they do not always reflect the
//      visual viewport, but adding WX & WY yields the page coordinates.
//
//   element.scrollIntoView()
//
//      This actually moves the viewport on Chrome -- the only way I'm aware
//      of.  Oddly, this fails when both (a) {behavior: "smooth"} is specified,
//      and (b) a pointer (finger) is currently "down".
//
//      Using this to synthesize a working scrollViewport() is such an ugly
//      hack we only use it when WY and visualViewport.pageTop differ (by 1.0
//      or more).
//
// ====  Determining Scroll Speed  ====
//
// To model the the regime of deceleration, it is simpler to model acceleration
// (reverse time) and choose time and distance units such that:
//
//   Accel start:    t = 0;  v = 0
//   Accel end:      t = 0;  v = 1
//
//   t = t_ms / TMAX
//   v = v_px_per_ms / VMAX
//   d = v * t = d_px / (TMAX * VMAX)
//
// d(t=0) = 0, but d(t=1) depends on the shape of the curve.  If it is
// linear:
//
//    v = t
//    d = t*t/2               =>  d(t=1) = 1/2
//    v = t = sqrt(2*d)
//
// Ultimately we want to calculate v_px_per_ms from d_px:
//
//  v_px_per_ms = VMAX * v
//              = VMAX * sqrt(2 * d)
//              = VMAX * sqrt(2 * d_px / (TMAX*VMAX))
//              = VMAX * (d_px / DMAX) ^ 0.5
//
//  where DMAX = d_px(t=1) = TMAX*VMAX/2
//
// The exponent of 0.5 models linear deceleration.  Increasing it will
// produce a more gradual stop and increase the duration of deceleration.
// At 1 the velocity decays exponentially (infinite duration), and at 0 we
// get an abrupt stop.

const W = window;
const D = document;
const visualViewport = W.visualViewport;
const requestAnimationFrame = W.requestAnimationFrame;
const se = D.scrollingElement;
const min = Math.min;

const VMAX = 0.5;                // px/ms
const TAccel = 500;              // duration of acceleration
const DDecel = TAccel*VMAX / 2;  // TAccel if deceleration is linear
const DecelExponent = 0.6;

// Construct an exposer.
//
// elem: element to keep exposed
// bounds: {top, left, width, height} = bounds of element travel
//     within which we expose
// pad: additional space to scroll into view beyond element extent
// notify: Changing scroll position while a drag operation is in
//    progress will effectively change the page-relative position
//    of the pointer, without generating a move event.  notify(adj)
//    is called to allow the client to account for this change.
//
// Returns:  activate: (isActive) -> ()
//    activate(true) checks element position and possibly updates or
//       initiates scrolling if necessary.  Once scrolling begins,
//       updates will be driven by farme callbacks.
//    activate(false) stops scrolling, if active.
//
let Exposer = (elem, bounds, pad, notify) => {
    let tBegun = 0;        // zero => not scrolling
    let tPrev = 0;         // time at last update
    let dtMoving;          // time since scrolling has begun
    let dtUpdate;          // time since last update
    let pending = 0;       // number of frame callbacks we expect (0 or 1)

    // boundaries of area to expose
    let minX = bounds.left - pad;
    let minY = bounds.top - pad;
    let maxX = bounds.left + bounds.width + pad;
    let maxY = bounds.top + bounds.height + pad;

    // Return scroll amount to be applied in the current frame callback
    // for one direction (e.g up, down, left, or right);
    //
    //    d = distance to limit of motion in this direction
    //
    let getStep = (d) => {
        let vDecel = VMAX * (d/DDecel)**DecelExponent;
        let vAccel = VMAX * dtMoving/TAccel;
        return min(d, dtUpdate * min(VMAX, vAccel, vDecel));
    };

    // Return scroll amount to be applied in the current frame callback, for
    // one dimension (e.g. X orY).
    //
    //   x0, x1 = element extent
    //   vx0, vx1 = viewport extent
    //   minX, minY = extent of area to expose
    //
    let calcStep = (x0, x1, vx0, vx1, minX, maxX) => {
        // left / right
        let dx;
        let dxMax = 0;
        if (x0 < vx0) {
            dx = x0 - vx0;
            dxMax = vx0 - minX;  // negative => no go
        } else if (x1 > vx1) {
            dx = x1 - vx1;
            dxMax = maxX - vx1;  // negative => no go
        }
        return dxMax > 0 && Math.sign(dx) * getStep(dxMax);
    };

    let vx0, vx1, vy0, vy1;

    // set vx0, vx1, vy0, vy1
    let readViewport = () => {
        vx0 = W.scrollX;
        vy0 = W.scrollY;
        vx1 = vx0 + se.clientWidth;
        vy1 = vy0 + se.clientHeight;
    };

    // Attempt to move the viewport by (dx, dy).
    let moveViewport = (dx, dy) => {
        W.scroll(vx0 + dx, vy0 + dy);
    };

    if (visualViewport) {
        // top/left and/or width/height may differ from above implementation
        readViewport = () => {
            vx0 = visualViewport.pageLeft;
            vy0 = visualViewport.pageTop;
            vx1 = vx0 + visualViewport.width;
            vy1 = vy0 + visualViewport.height;
        };

        // In Chrome, even when scrollX/Y agree with viewport left/top, the
        // layout viewport might not be scrollable while the viewport is,
        // so we resort to this hack whenever visualViewport is present....

        moveViewport = (dx, dy) => {
            let ee = D.createElement("div");
            ee.style.position = "absolute";
            ee.style.width = "1px";
            ee.style.height = "1px";
            ee.style.left = (dx + (dx < 0 ? vx0 : vx1-1)) + "px";
            ee.style.top = (dy + (dy < 0 ? vy0 : vy1-1)) + "px";
            D.body.appendChild(ee);
            ee.scrollIntoView({block: "nearest"});
            D.body.removeChild(ee);
        };
    }


    let update;

    let callback = () => {
        if (--pending == 0) {
            update();
        }
    };

    let schedule = () => {
        if (tBegun && pending < 1) {
            pending = 1;
            requestAnimationFrame(callback);
        }
    };

    let stop = () => {
        pending = 0;
        tBegun = 0;
    };

    // errorX/Y = actual scroll position - intended scroll position
    //
    // Actual position is is granular in a browser-specific way.  We track this
    // to ensure progress (over multiple frames) when our per-frame scroll
    // amount is below the granularity.
    let errorX, errorY;

    update = () => {
        let tNow = performance.now();
        dtMoving = tNow - tBegun;
        dtUpdate = tNow - tPrev;
        tPrev = tNow;

        if (dtUpdate < 8) {
            // A pointer event must have coincided with a frame
            // callback... wait until next frame.  Otherwise, with dtUpdate==0
            // or dtMoving==0 we will calculate a zero stepX or stepY below and
            // stop scrolling.
            schedule();
            return;
        }

        // update vx0, vx1, vy0, vy1
        readViewport();

        // element extent (page-relative)
        let r = elem.getBoundingClientRect();
        let wx = W.scrollX;
        let wy = W.scrollY;

        // Start scrolling when the element is within a "buffer" zone around
        // the viewport edges, but reduce this (even to negative values)
        // when the element is large.  Ensure that it can be moved at least
        // +/- a quarter of its size without triggerring scrolling.
        let xBuff = min(pad, (vx1 - vx0) - (r.right - r.left)*5/4);
        let yBuff = min(pad, (vy1 - vy0) - (r.bottom - r.top)*5/4);

        let x0 = r.left + wx - xBuff;
        let x1 = r.right + wx + xBuff;
        let y0 = r.top + wy - yBuff;
        let y1 = r.bottom + wy + yBuff;

        let stepX = calcStep(x0, x1, vx0, vx1, minX, maxX);
        let stepY = calcStep(y0, y1, vy0, vy1, minY, maxY);

        if (tBegun) {
            if (stepX || stepY) {
                let oldX = vx0;
                let oldY = vy0;
                stepX -= errorX;
                stepY -= errorY;
                moveViewport(stepX, stepY);
                readViewport();
                let dx = vx0 - oldX;   // *actual* change
                let dy = vy0 - oldY;   // *actual* change
                errorX = dx - stepX;
                errorY = dy - stepY;
                notify(dx, dy);
            } else {
                // stop
                tBegun = 0;
            }
        } else {
            if (stepX || stepY) {
                // start
                tBegun = tNow;
                errorX = errorY = 0;
            }
        }

        schedule();
    };

    return (isActive) => isActive ? update() : stop();
}

export {Exposer as default};
