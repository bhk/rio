# ROP: Remote Observation Protocol

## Remote Observation

ROP enables communication between software domains using reactive functional
semantics.  Just as [RPC and RMI](remoting.md) embody the abstraction
mechanisms of procedural and object-oriented languages, respectively, ROP is
designed to integreate seamlessly into a Rio environment, or a JavaScript
environment using `i.js`.


## ROP Concepts

ROP describes communication across a bi-directional message-based
communication channel between two **domains**.  In each domain, an **agent*
is responsible for sending and receiving ROP messages and mating them to the
mechanisms native to its environment.

Almost all ROP messages occur in the context of a **slot**, which is a
protocol abstraction that represents the act of observing a time-varying
remote value.  Each slot comes into existence when named by a request (from
the **client** side of the observation) to call a **function** or evaluate a
**thunk** that resides in the other domain (the **host** side).  A slot
ceases to be when the client, no longer interested in the results of the
observation, **ends** the slot and the server acknowledges it.

  A thunk represents a computation whose result has not yet been evaluated
  or inspected.  Lazy expressions and parallel expressions are examples. A
  cell can hold a thunk reference without incurring a data dependency on the
  result of the thunk.  A *use* operation will reveal the underlying value
  (reducing the lazy expression, or collecting a parallel result) and
  establish a data dependency.  Thunks are like functions that do not accept
  any values, but they can be used in place of ordinary values and their
  invocation is done implicitly on demand (depending on the programming
  language).

Messages convey two types of values: **literals** and **references**.
Literal values are serialized and sent across the link in their entirety.
Referenced values are named by **oids**, non-negative integers assigned by
the hosting agent.  Functions and thunks are always passed by reference.

Results can be in one of three conditions: Success, Pending, and Error.

 * Success indicates an ordinary result.

 * Error indicates a failure on the host side (e.g. an uncaught exception).
   By design, ROP agents propagate errors downstream to keep the function
   call analogy clean and allow remoting to be as unobtrusive as possible.

 * Pending is another "exceptional" state, but one that is commonly
   encountered and intended to be communicated swiftly and efficiently.

Remote evaluations always return a potentially time-varying (reactive)
value, due to the inherent potential for communication delays, as well as
the potential for reactive evaluation on the host.  A remote function call
will initially have a Pending result, and later transition to the condition
indicated by the host.


## Messages

The protocol is symmetrical: each message can be sent in either direction.
However, within a given slot, messages are strictly associated with either
the client (C) or host (H) side.

    Messages = one of:
       Start     slot oid value...   // C: call function/use thunk
       Result    slot cond value     // H: deliver result value
       AckResult slot                // C: acknowledge Result
       End       slot                // C: stop observing & release value
       AckEnd    slot                // H: acknowledge End
       Error     msg                 // *: report protocol error

    Value = one of:
       Data value          // JSON value
       Fn soid             // reference to function
       Thunk soid          // reference to reactive value
       Opaque soid         // reference to unspecified value

    Cond = one of:
       Success             // ordinary result
       Pending             // result not yet available
       Error               // error/exception

    Slot = integer

       Slots are identified by unique integers allocated by the client agent
       and identified in the initiating Start message.

    OID = non-negative integer

    SOID = integer

       A non-negative value X represents oid X in the recipient domain.  A
       negative value -Y represents oid Y-1 in the sender's reference table.


### Observations

Observations either call a function or use a thunk, depending on the type of
the referenced object.

An observation is initiated with `Start` and terminated with `End` and the
peer's `AckEnd`.  In between, one or more `Result` messages may come in
response.

    --> Start slot oid values

    <-- Result slot value    # these may occur one
    --> AckResult slot       #   or more times

    --> End slot
    <-- AckEnd slot


Note that incoming `Result` messages could be received after `End` is sent
and before `AckEnd` is received:

    --> End slot
    <-- Result slot value    # possible, but harmless (ignored)
    <-- AckEnd slot


## Details


### Reference Liveness

Slots control reference lifetimes.

A reference table entry is considered live -- that is, a peer might hold a
valid reference -- when the reference was sent to the peer on a slot that is
still live, unless the reference has been replaced.

In JavaScript, this allows us to attach client slot lifetimes to client-side
cell lifetimes, ensuring cleanup of host-side resources without relying on
finalizers.  (`i.js` uses [liveness to control lifetimes of
cells](incremental.md#liveness-and-lifetimes).)

Acknowledgement messages are important for managing lifetimes.  When an
client sends `End slot`, it must wait for the host's `AckEnd slot` before
considering the slot reusable.  Likewise, when a host sends `Result` on a
slot, it must wait for the clients `AckResult` before considering the
previous value expired.

Note: A given object might appear in more than one live slot at a time; it
will remain a live reference as long as it is live in any of those slots.


### `Error` Messages

A `Error` message is sent when an agent detects an invalid internal state or
a protocol error, such as a mal-formed or unrecognized message.  For
robustness purposes, the connection will be terminated.  The message is for
diagnostic purposes.

Provisions for feature detection may be provided in the future.


### Serialization

Messages are JS arrays serialized using JSON, after `value` elements are
transformed to encode non-JSON values as strings that begin with `.` and a
character that designates the type of the value.  Actual strings that begin
with `.` are encoded with an extra `.`.

    thunk     -->  ".T" + SOID
    function  -->  ".F" + SOID
    opaque    -->  ".O" + SOID
    ".string" -->  "..string"

Other type characters might be used to represent language-specific types in
the future.  Agents should deserialize strings with unknown type characters
to some value distinguishable from understood serialization results, so that
transactions can continue to succeed when clients ignore the value, and so
that clients can detect lack of support.


## Reference Equality

When the same referenced value, or equivalent ones, are used in more than
one place at a time, the same reference ID should be used, so equality tests
in the peer domain will behave the same as in the local domain.


## Startup

When a connection is initiated, each peer will hold a set of "primordial"
references.  These can be called or evaluated to inspect values or obtain
other references.

The precise set of primoridial values and their function is
application-specific.

Authentication can be implemented atop the observation protocol.  A typical
scenario would be for the server domain to offer one primordial function
that does nothing but accept credentials and, on success, return a function
that provides more functionality.


## Notes


### Rio Language Binding

ROP function and thunk references identify Rio functions and thunks.  A
thunk may be a cell or lazy thunk on the host side, but these are not
distinguished in ROP.  In Rio, cells and lazy thunks are indistinguishable
from each other (and from computed values).

At the implementation level, host-side thunks and functions will be
represented by client-side "forwarder" thunks and functions.  When
evaluated/called, a forwarder initiates a slot and constructs an input cell
to observe it, marking that cell as a dependency of the user/caller of the
forwarder.

On the host side, when the ROP agent recieves a `Start` message it will
construct a cell to handle the operation whether or not the invoked
reference is a cell, because function calls and thunk evaluations can
introduce dependencies on other cells.

Function call observations can send and receive thunk references.  Thunk
observations have no arguments, and the result will not be a thunk.  The
result might be an aggregate value that *contains* a thunk, but any "bare"
thunk will be reduced to a non-thunk value on the host-side before being
returned to the client.  (That is the objective of `use`, after all.)


### Synchronization

Rio & `i.js` guarantee a consistent result, despite any out-of-order
execution of cells.  ROP does not.

Consider this example:

    t = defer getTime()
    t1 = defer t + 1
    t2 = defer t - 1
    d = subtract(t1, t2)            # ALWAYS 2

Consider the slots involved in calling `subtract` over ROP:

    --> Start 0 SUBTRACT thunkT1 thunkT2
    <-- Start 1 thunkT1
    <-- Start 2 thunkT2
    --> Result 1 1001
    --> Result 2 999
    <-- Result 0 2                  d = 2

After the time changes, the following sequence might happen:

    --> Result 1 2001
    <-- Result 0 1002               d = 1002  (inconsistent)
    --> Result 2 1999
    <-- Result 0 2                  d = 2


### Retained References...

Should we consider inbound Start arguments part of the live set, if they
reference local objects?  The reason we would *not* include these is that in
a pure reactive system, such an inbound call could not exist except within
the context of some other observation that *sends* the reference.  So this
should not happen:

    <-- Start 2 F X            # passes X
    <-- End/AckEnd 1           # releases X

If we have some stateful operation in the peer domain that is holding on to
one of our references, it should keep open the slot that provided it with
that reference, by refraining from sending End or AckEnd.


## Typing

In future protocol versions, type information could be conveyed along with
each reference.  In the case of functions, the types would describe
arguments and results, and in the case of thunks, the results.

This type information could reduce the amount of type information conveyed
with arguments and results, and could allow some operations to be completed
without messaging, notably:

 - Type errors.
 - Type introspection.

As with gradual typing in the host language, this protocol-level typing at
the protocol level would be optional or, equivalently, allowing for
`Any`-typed values.
