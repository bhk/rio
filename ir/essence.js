// Simplest Essentials of Reactive Evaluation
//
// Entanglement...
//
// Two buttons, each showing the count of clicks of the other.
//
// e1 = elem(count(e2.events.click))
// e2 = elem(count(e1.events.click))
//
//     Infinite regress.  Note this is: y = f(x); x = f(y)
//
// e1 = elem(count(events[2].click, id=1))
// e2 = elem(count(events[1].click, id=2))
//
//    Non-hygienic, global data.  We could pass events to e1 & e2, but still
//    we are dealing with an `events` object that represents all elements.
//
//    Deeper problems:
//     - In a functional language, evaluations are not unique.
//     - What if we evaluate one of these expressions twice?
//     - What if we put e1 in two different places in the document?
//
// id1 = doc.genID()
// id2 = doc.genID()
// e1 = id1.elem(count(id2.events.click))
// e2 = id2.elem(count(id1.events.click))
//
//    Note:   id2.events.click  <-~->  events[id2].click
//    Equivalent to global but hygienic.
//    genID() is not a *function*.
//
// do
//   id1 <- genID
//   id2 <- genID
//   e1 = id1.elem(count(id2.events.click))
//   e2 = id2.elem(count(id1.events.click))
//   id <- genID
//   id.elem([e1, e2])
//
//       We could treat elem() as a function that just constructs
//       a description of an element.
//
//
//
// genID.bind(id1 ->
//   genID.bind(id2 ->
//     id1.elem(...).bind(e1 ->
//       id2.elem(...).bind(e2 ->
//         return [e1, e2]))))
//
//

//  bind :: M a -> (a -> M b) -> M b
//  return :: a -> M a

// The monad instances are just action decriptions.  We never see the
// "World" object that they ultimately get used to work on.

// action = do str <- read 5;

// action = (read 5).bind(str -> return str)


//
// [e1, e2] = withNewID(id1 ->
//     withNewID(id2 ->
//


// e1 describes how to "mount" an element.  Only when mounted do we have an
// identity for the event stream.
//
//   (doc, eventStream) = mount(doc, element)

let e1, e2


let layout = [e1, e2];
let events = [0,1,0];

// process events, computing element content
