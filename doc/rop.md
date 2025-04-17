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
is responsible for sending and receiving ROP messages and introducing the
functionality to the surrounding execution environment.

Almost all ROP messages occur in the context of a **slot**, which is a
protocol construct that represents the act of observing a time-varying
remote value.  Each slot begins with a request (from the **client** side of
the observation) to call a **function** or evaluate a **thunk** that resides
in the other domain (the **host** side).  An slot ends when the client, no
longer interested in the results of the observation, **drops** the slot.

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
References are named by IDs assigned by the agent in their hosting domain.
Functions and thunks are always passed by reference; other values are
literal.

Remote evaluations always return a potentially time-varying (reactive)
value, due to the inherent potential for communication delays.  Remote
evaluation of a function call or thunk will initially take on a "pending
error" result -- an Error value that indicates the temporary lack of a
result; any **use** of any Error value by the client will result in a Rio
error or JS exception being thrown.  This pending error will later be
replaced by the value sent in the response from the other domain, which may
in turn be replaced again and again (due to changing inputs).


## Messages

The protocol is symmetrical: each message can be sent in either direction.
However, within a given slot, messages are strictly associated with either
the client (C) or host (H) side.

    Messages = one of:
       Call      slot ref value...   // C: begin function call
       Use       slot ref            // C: begin thunk reduction
       Result    slot value          // H: deliver result value
       AckResult slot                // C: acknowledge Result
       Drop      slot                // C: stop observing & release value
       AckDrop   slot                // H: acknowledge Drop
       Error     msg                 // *: report protocol

    Value = one of:
      Data value          // JSON value
      Fn ref              // reference to function
      Thunk ref           // reference to reactive value
      Error value         // error/exception

    Slot = integer

      Slots are identified by unique integers allocated by the client agent
      and identified in the initiating Call or Use message.


    Ref = integer

      Reference values use the sign of the integer to indicate the domain
      hosting the referenced value.  A non-negative value X represents index X
      into the recipient's reference table.  A negative value -Y represents
      index Y-1 in the sender's reference table.


### Observations

An observation is initiated with `Call` or `Use` and terminated with `Drop`
and the peer's `AckDrop`.  In between, one or more `Result` messages may come
in response.

    --> Call slot ref values
          ... or ...
        Use slot ref

    <-- Result slot value    # these may occur one
    --> AckResult slot       #   or more times

    --> Drop slot
    <-- AckDrop slot


Note that incoming `Result` messages could be received after `Drop` is sent
and before `AckDrop` is received:

    --> Drop slot
    <-- Result slot value    # possible, but harmless (ignored)
    <-- AckDrop slot


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
client sends `Drop slot`, it must wait for the host's `AckDrop slot` before
considering the slot reusable.  Likewise, when a host sends `Result` on a
slot, it must wait for the clients `AckResult` before considering the
previous value expired.

Note: A given object might appear in more than one live slot at a time; it
will remain a live reference as long as it is live in any of those slots.


### `Error` Values

Exceptions or errors during evaluation of a function call or thunk are
reported as a result value of type `Error`.


### `Error` Messages

A `Error` message is sent when an agent detects an invalid internal state or
a protocol error, such as a mal-formed or unrecognized message.  For
robustness purposes, the connection will be terminated.  The message is for
diagnostic purposes.

Provisions for feature detection may be provided in the future.


### Serialization

Messages are JS arrays serialized using JSON, after `value` elements are
transformed to encode references and then encode Value subtypes as JSON
values.

  thunk      -->  Thunk N    -->  ["C", N]
  function   -->  Fn N       -->  ["F", N]
  error      -->  Error S    -->  ["E", S]
  array      -->  A          -->  ["A", A]
  other      -->  X          -->  X


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

### Synchronization

Rio & `i.js` guarantee a consistent result, despite any out-of-order
execution of cells.  ROP does not.

Consider this example:

    t = defer getTime()
    t1 = defer t + 1
    t2 = defer t - 1
    d = subtract(t1, t2)      # ALWAYS 2

Over ROP (without further cahnges) we can see this:

    --> Call 0 SUBTRACT thunkT1 thunkT2
    <-- Use 1 thunkT1
    <-- Use 2 thunkT2
    --> Result 1 1001
    --> Result 2 999
    <-- Result 0 2                     (eventually settles to this)

After the time changes, the following sequence may happen:

    --> Result 1 2001
    <-- Result 0 1002                  Inconsistent result!
    --> Result 2 1999
    <-- Result 0 2


### Example

Mapping map OO interfaces to function calls could result in something like
the following:

    dbs = Opener.register(credentials, eventSource)

        --> Call 10, 0, "register", credentials, ["O",-1]  # -1=eventSource
        <-- Result 10 -1            # -1 = dbs
        --> AckResult 10
        <-- Watch 20 1 "getEvent"   # 1=eventSource
        --> Result 20
        <-- AckResult 20
        ...

### Retained References...

Should we consider inbound Call arguments part of the live set, if they
reference local objects?  The reason we would *not* include these is that in
a pure reactive system, such an inbound call could not exist except within
the context of some other observation that *sends* the reference.  So this
should not happen:

   <-- Call 2 F X            # passes X
   <-- Drop/AckDrop 1        # releases X

If we have some stateful operation in the peer domain that is holding on to
one of our references, it should keep open the slot that provided it with
that reference, by refraining from sending Drop or AckDrop.
