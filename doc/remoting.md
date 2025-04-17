# Remoting Overview

## Introduction

Imagine two programs running in separate worlds, across networked machines
or isolated domains on a single kernel, yet needing to work as one. At their
core, they rely on exchanging byte-array messages. Every programming
language provides a native communication model, like procedure calls in C or
method invocations in Java, but these rarely span distinct domains
naturally.

A remoting framework that extends these models across domains can greatly
simplify the resulting software. Remarkably, these frameworks mirror the
strengths and weaknesses of the programming languages they align
with—sharing their elegance, quirks, and limitations. In this document, we
explore key remoting frameworks—RPC and remote object systems—unpacking
their designs, benefits, and challenges.


## Remote Procedures

Remote Procedure Call (RPC) reflects the procedural nature of languages like
C, where communication hinges on global functions. Just as C relies on
procedure calls, RPC extends this abstraction across domains. A client in
one domain invokes a "down proxy", a local stand-in with the same function
names as the remote service. This proxy constructs messages and hands them
to a gateway (GW), which sends them to a peer GW in the service’s
domain. There, an "up proxy" receives the message and calls the actual
service. Results return back along the same path.


    +-----------------------+------------------------+
    |                       |                        |
    | client  --->  down    |      up   ---> service |
    |               proxy   |     proxy              |
    |                 |     |     ^                  |
    |          send() |     |     | send()           |
    |                 v     |     |                  |
    |                 GW  --|-->  GW                 |
    |                       |                        |
    +-----------------------+------------------------+


The gateways form a generic transport layer, while proxies are tailored to
specific APIs. Ideally, tools auto-generate these proxies, freeing
developers to focus on functionality. But C’s type system, mirroring its
simplicity as a language, poses a challenge: it can’t fully describe inputs,
outputs, or memory layouts (e.g., pointers vs. arrays). This forces reliance
on a separate interface definition language (IDL) or annotated C, echoing
how C’s minimalism both empowers and constrains programmers.


## Remote Objects

RPC’s procedural roots reveal limitations, especially in managing context,
modularity, and extensibility -- issues familiar to anyone who’s wrestled
with global state in C. Consider these challenges:

 * **Contexts**: Services often manage resources (e.g., graphics contexts)
   for clients via opaque handles. Proxies must validate these, track their
   creation and destruction, and clean up if a domain fails.  All this
   requires extra metadata about APIs.

 * **Callbacks**: RPC struggles to support callbacks without sacrificing
   modularity, as reverse calls need predefined names in a global namespace.

 * **Modularity**: Global function names clash with modular design, forcing
   infrastructure updates for every change.

Enter Remote Method Invocation (RMI), akin to object-oritented programming
(OOP) as RPC is to procedural code.  Each remote object encapsulates a
context in its domain and exposes methods to manipulate it. Proxies become
objects too, not just function sets.

Object *references* can be passed across domains, with proxies created
dynamically as needed.  When references return home, proxies can be peeled
away enabling local state access and type validation.

### Benefits of the Object Model

This shift mirrors OOP’s advantages over procedural languages:

 * Polymorphism: Local and remote resources (e.g., file systems) can share
   an interface, letting client code work seamlessly with either.

 * Encapsulation: Services avoid global variables, much like objects
   localize state.

 * Modularity: Methods tie to instances, not a global namespace, enabling
   independent proxy development.

 * Callbacks: Clients pass object references for callbacks, with the
   framework managing their lifecycle, mirroring how OOP handles closures.

 * Cleanup: A uniform "release" method simplifies resource management, no
   annotations needed.

 * Security: Object references act as capabilities, granting access
   dynamically -- like passing a key -- unlike RPC’s static function calls.


## Remote Reactive Functions

Object-oriented programming and remoting leave us with some shortcomings
related to dealing with change and notifications:

 * **Inefficiency of Synchronous Polling**: Repeated synchronous remote method
   calls to check for updates is inefficient and introduces latency compared
   to an asynchronous approach where updates are pushed from the remote
   domain.  This makes a notification-based approach, using something like
   the Observer Pattern, a necessity in most cases.

 * **Overhead of Observer Setup**: Mimicking dynamic updates via observer
   objects requires verbose code for registration, notification delivery,
   and handling.  This translates into chattiness at the protocol level.

 * **Circular References**: Observer patterns create circular references
   between domains, entangling object lifetimes. This forces reliance on
   weak references or manual cleanup, beyond what reference counting or
   garbage collection can easily handle.

 * **Race Conditions and Re-Entrancy**: Notifications and object releases
   can introduce re-entrancy even in single-threaded systems, and any form
   of re-entrancy with notifications can introduce race conditions that can
   result in hard to find bugs.

In a functional programming model with **intrinsic reactivity**, as
implemented in [Rio](incremental.md), entities are pure functions whose
results can evolve over time. When a remote function is invoked, the calling
programming environment tracks what computations depend upon it.  Implicit
in each function call is registration for change notifications.  When the
remote domain later notifies of new results, they are not handled in an *ad
hoc* manner; instead, the local programming environment 'freshens' all
affected computations in a single, consistent sweep, as if re-evaluating the
entire program purely at that moment in time. This intrinsic reactivity
eliminates manual polling or observer management, delivering a seamless,
snapshot-driven update process.


## Protocol-Level Concerns


### Layering

Now consider a chain of domains: A connects to B, which connects to C. A
client in A might access a service in C via B. With basic remoting, this
requires full proxy stacks in each hop:

    +-------------------+--------------------+------------------+
    |         A         |          B         |         C        |
    |                   |                    |                  |
    | client --> down   |     up  --> down   |     up  --> impl |
    |            proxy  |    proxy    proxy  |    proxy         |
    |              |    |      ^        |    |      ^           |
    |              v    |      |        v    |      |           |
    |              GW --|-->  GW        GW --|-->  GW           |
    +-------------------+--------------------+------------------+

This works but incurs overhead: B must de-marshal and re-marshal all data. A
"forward proxy" in B could redirect messages directly from A to C, bypassing
this:

    +-------------------+---------------------+------------------+
    |         A         |          B          |         C        |
    |                   |                     |                  |
    | client --> down   |                     |     up  --> impl |
    |            proxy  |     forward proxy   |    proxy         |
    |              |    |      ^        |     |      ^           |
    |              v    |      |        v     |      |           |
    |              GW --|-->  GW        GW  --|-->  GW           |
    +-------------------+---------------------+------------------+

Even so, B must understand C’s interfaces.

We can avoid the need for any proxy and pass the underlying messages from
gateway to gateway, but in order to do so we must be able to rely on the
gateway to maintain security guarantees.  This layering has a big
implication for the protocol design: the messages must distinguish objects
from raw data, so that the generic transport layer can validate them and
track lifecycles.


### Other Concerns

Here are a number of other issues that have arisen in design of remote
communication protocols.  These can be thought of as a checklist of
things to think about when evaluating or building such a system.

* Threading and Re-entry
   - Transaction IDs in message enable multiple threads per channel
   - Single-threaded vs. multi-threaded dispatch
   - Synchronous re-entry into blocked threads vs. disallowed
   - One-way (asynchronous) invocations
      - One-way release => avoids re-entry
      - payload-less & coalesced => can always be "queued"
* Flow Control
   - Message size limit
   - Sub-message granularity?
   - Buffering limit (all messages)
   - Coalescing?
* Notifications and Reference Cycles
* Transport-layer Semantics
   - Errors
   - QoS (priorities, etc.)
   - ping, traceroute
   - Method disposition: Synch vs. asynch vs. coalesced
* Chaining (without transport-to-native-to-transport conversion)
* Types of Domain Boundaries
   - Language boundary: C => Rust => C++
   - VM boundary
   - User-to-Kernel
   - Inter-process
   - Network (sockets, HTTP, ssh, ...)
* Security Concerns
   - Capabilities & confused deputy
   - Leakage of data (padding)
   - Leakage of capability (e.g. get prototype of X, modify prototype)
   - Peer-to-peer vs. parent-child domains
   - Validation (types, bounds, etc.)
   - Unsafe language concerns (pointers, indices, alignment,...)
   - Blocking (non-reponsive domain)
* Redundant links & constructing alternate paths
   - Rendezvous service: capability <--> secret
