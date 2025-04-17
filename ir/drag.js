//----------------------------------------------------------------
// Drag-and-drop & event handling helper
//----------------------------------------------------------------
//
//   handleDrag(elem, target) -> deregFn
//   listen(elem, listeners, useCapture) -> deregFn
//

// Register listeners and return a functon that will de-register them.
//
//   listeners: object mapping event names to functions
//
let listen = (elem, listeners, useCapture) => {
    let reg = (name, fn, chainDereg) => {
        elem.addEventListener(name, fn, useCapture);
        return () => {
            elem.removeEventListener(name, fn, useCapture);
            if (chainDereg) {
                chainDereg();
            }
        };
    };

    let dereg;
    for (let name in listeners) {
        dereg = reg(name, listeners[name], dereg);
    }
    return dereg;
};

// Listen for drag events on `elem`, notifying `target` object.
// Return a function that terminates listening for drag events.
//
// Target must implement:
//
//   target.dragStart(): called when dragging begins.
//
//   target.dragStop(isDrop): called on completion. When `isDrop` is
//        non-truthy, the operation has been canceled.
//
//   target.dragMove(dx, dy, event): called zero or more times between
//        dragStart & dragStop.  (dx, dy) gives the current (dragged)
//        position minus the starting position.
//
// Note that the CSS property "touch-action: none;" should be applied to the
// element, as per <www.w3.org/TR/pointerevents2/>.
//
// Implementation note:
//
// If we get a second "down" before an "up", that means either a second
// pointer is trying to drag the element, or we have missed the "up".  In
// the latter case, we don't want to remain stuck forever, so we switch to
// tracking the new pointer ID (if different), and continue sending the
// client "move" updates without terminating the drag operation.  In the
// former case, this means that the second pointer "takes over".
//
let handleDrag = (elem, obj) => {

    let releaseCapture = (id) => {
        if (id != null && elem.hasPointerCapture(id)) {
            elem.releasePointerCapture(id);
        }
    };

    // When null/undefined, tracking is not in progress.
    // Otherwise, the ID of the pointer we are tracking.
    let activeID;

    // When dragging, the starting pointer location
    let startX, startY;


    let pointerdown = (event) => {
        if (event.button != 0) {
            return;
        }

        let deregTrackers;

        let stop = (isDrop) => {
            if (activeID != null) {
               releaseCapture(activeID);
                activeID = null;
                deregTrackers();
                obj.dragStop(isDrop);
            }
        };

        let trackers = {
            pointerup: (event) => {
                if (activeID == event.pointerId) {
                    stop(true);
                }
            },

            pointermove: (event) => {
                if (activeID == event.pointerId) {
                    let isDown = (event.buttons || 0) & 1;
                    if (isDown) {
                        obj.dragMove(event.pageX - startX,
                                     event.pageY - startY,
                                    event);
                    } else {
                        // Missed pointerup?
                        stop();
                    }
                }
            },

            lostpointercapture: (event) => {
                if (activeID == event.pointerId) {
                    stop();
                }
            },
        };

        let oldID = activeID;
        activeID = event.pointerId;

        if (!oldID) {
            // begin tracking
            startX = event.pageX;
            startY = event.pageY;
            deregTrackers = listen(elem, trackers, false);
            obj.dragStart();
        }

        if (activeID != oldID) {
            releaseCapture(oldID);
            elem.setPointerCapture(activeID);
        }
    };

    // On race condition: any race conditions resulting from using
    // addEventListener() in a handler would also manifest when using
    // setPointerCapture() in a handler ... and since there's no other
    // option for sPC(), browsers need to serialize dispatching (no queueing
    // after associating events with elements).

    let dereg = listen(elem, {pointerdown}, false);

    return () => {
        stop();
        dereg();
    };
};

export {handleDrag, listen};
