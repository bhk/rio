# Incremental Reactive Evaluation

## Introduction

Spreadsheets and build systems manage large computations and automatically
recompute them efficiently when inputs change, reusing prior results when
they are not affected.  We intend to extend this idea to general-purpose
programming, eliminating the need to manually handle updates and
notifications. Consider the difference between a script generating a static
HTML report from database queries and a browser script rendering a live,
auto-updating version of the same.  Rio's Incremental Reactive Evaluation
targets the simplicity of the former with the responsiveness of the latter.
See [below](#the-notification-problem) for a deeper analysis of how update
complexity burdens modern software.


## How It Works

Rio starts with a functional approach to programming, and then allows a
function to be to be evaluated and then efficiently **updated**
(re-evaluated) with different inputs.  Each update can re-use the results of
prior computations that have not been invalidated by changes.

Efficiency is achieved by subdividing the computation into units of work
called **cells**.  Each cell yields a value.  A cell may **use** (consume)
the values of other cells, making them **dependencies**.  The cells that
comprise a computation and their dependency relationships describe a
directed, acyclic graph (DAG) with one or more sources and a single sink
(the result).

**Input cells** represent external inputs to the system, which can change
over time.  The system provides some of these cells as primitives, and
provides functions to construct others.  For example, an input cell could
represent the current time, and the function call `readFile("a.txt")` could
construct an input cell.

During an update (after one or more input cells have changed), cells whose
dependencies have changed will be **recalculated**, which may result in a
change to the inputs of other cells, which will also have to be
recalculated.  All the remaining cells -- those whose dependencies have not
changed -- can be resued without repeating their computation.  The lack of
side effects or mutable state in Rio means that, given the same
dependencies, a cell will return the same value.  When we say that inputs
can change over time, we mean they can *differ* (there is no mutation of
data) from one evaluation to the next (not during a single evaluation).
Each update is a purely functional computation that yields the same result
as a complete re-evaluation of the program.

Unlike spreadsheets and most build systems, the structure of the dependency
graph is inherently dynamic.  As the function is evaluated and cells are
constructed and used, the graph is populated.  Programmers annotate their
code to mark subexpressions that should be evaluated in a cell.

An **program** is defined by a main function to be invoked by the runtime.
A **program instance** is created when the system calls the main function.
A **root cell** is constructed to contain this evaluation.  During execution
of the root cell, other cells may be used, which may in turn use other
cells, thereby constructing a graph of cells, all descendants of the root
cell.

After the root cell is evaluated, the program instance does not immediately
terminate.  Instead, the runtime waits for changes to inputs.  While the
program is "running", whenever inputs to the program change the root cell is
updated.  Each update of the root is called a **cycle**.


## Programming with Cells

We now consider more concretely how it applies to writing programs in Rio.

### Constructing a Cell

The `memo&` function constructs a cell to contain an expression.

       v = memo&(f(x, y, z))

Cell construction is **memoized**.  Instead of a newly constructed cell, it
might return an identical cell that has already been created, perhaps in an
earlier update, or earlier in the same update.  This is crucial to retaining
used cells across a recalculation of their using cell.  See
[Equivalence](#equivalence), below for details.

Note how the notion of a cell as a function is distinct from the functions
in your program.  A cell is defined by an *expression*, and while the
expression might consist of just one function call, those function arguments
are not necessarily dependencies of the cell.  In the above example, `x`,
`y`, and `z` are arguments to function `f`, but their values are not
dependencies of the cell.  Instead, their values are part of the *identity*
of the cell.  If the `memo(...)` call is evaluated twice with different
values of `x` in scope, it will return a different cell each time.  The
inputs of a cell are the cells whose results it consumes as it is computed.

More generally, the shape of the cell dependency graph will not resemble the
structure of your program.  If a single cell definition -- one sport in the
source code -- is evaluated multiple times, it might generate multiple
cells.  You program's structure will be guided by the usual software
considerations of modularity and readability, whereas the dependency graph
arises from the dynamics of its execution.


### Using a Cell

The act of **using** a cell (obtaining its value) is distinct from
constructing a cell, just as constructing a closure and evaluating it are
distinct.

Like lazy expressions, cells are interchangeable with ordinary values, and
evaluation will be performed when necessary, automatically, without any
explicit code to that effect.  They can be assigned to variables and passed
to functions without triggering evaluation.

    x = memo&(f(7))         # construct cell for f(7)
    y = f(9)                # evaluate f(9) now
    z = x + y               # evaluate x, mark x as a dependency


### Cell Exceptions

Uncaught exceptions that occur during evaluation of a cell halt its
execution and put the cell in an error state.  Any *use* of a cell that is
in an error state will re-throw that error from the point of use, not from
the point of construction.  These errors can be caught by wrapping the use
in a try block.


### Streams

TBD


### Action Objects

TBD


### Reactive I/O

Incremental Reactive Evaluation provides a solution for I/O that suits a
pure functional language and deals with I/O delays without the need for
callbacks or "monadic" constructs.

Inputs can be represented as the results of functions, like:

    t = IO.getURL("http://example.com/test.txt")

This will initially take on a value that indicates the pending status of the
request, and over time will change to reflect partial results, and finally
transition to a completed (or error) state.  Expressions that depend on this
result will be re-evaluated as necessary.  Note how this behavior would
make it easy to properly reflect status in a user interface.

Outputs can be achieved by constructing an action object (cf. monadic I/O)
around a function that returns a time-changing value that eventually
transitions to a completion state.  Such action objects can be returned from
a `main` function, or from event handlers.

Reactive I/O operations can be ephemeral, needing to restart after
temporarily being excluded from the live set.  The programmer will have to
decide what behavior is desired, and perhaps be more explicit about
persistence.  [This could involve placing the operation in a state object
that is passed into the using cell, or perhaps using contexts that group
cell lifetimes. TBD]


## Implementation Notes


### Minimal Update Algorithm

Here are a couple of requirements that we would like the update algorithm to
satisfy:

1. Minimality: Only **invalid** and **live** nodes shall be recalculated,
   and each node should be recalculated at most once.  By invalid, we mean
   that its dependencies have changed.  By live, we mean that it is in fact
   used in this update, and will remain part of the dependency graph.

2. Consistency: The resulting graph and values must match what would result
   from a complete, non-incremental evaluation.  This implies that *all*
   invalid and live nodes are recalculated.

At first glance, the minimality requirement seems difficult to meet.  In
order to determine invalidity of a cell, we must first update the cells
above it in the graph (the cells it uses).  To determine liveness, we must
first update the cells below it (the cells that use it).  The dynamic nature
of the graph means we cannot blithely assume liveness.

This logjam can be broken by noting the order in which dependencies are used
by a cell.  The first dependency of a live cell must also be live, since
nothing has changed that might affect its decision to use that cell.
Likewise, if the first dependency's value is unchanged, we know the second
dependency will remain live.  Generally, a dependency of a live cell is
*live* when all prior siblings are *unchanged*.

Therefore, in order to update a live cell, we can update its dependencies,
in order, until we find one that has changed.  If no dependencies have
changed, our cell remains valid and its update is complete.  If a dependency
has changed, we know our cell is invalid and *it* must be recalculated.
During recalculation, we recursively update any dependencies cells as they
are used.

The update algorithm can begin at the root, which we know is always live.

So far we have described how to proceed one cell at a time, as in a single
threaded enironment.  This can be extended to enable parallel execution, but
we will not dive into those complications at this time.  Here we only make
these observations:

 * If programs explicitly trigger parallel evaluation, it might result in
   parallelism within a cell, to which an update algorithm would remain
   oblivious.

 * Dependencies used in separate threads of execution are not ordered with
   respect to each other; if prior dependencies remain unchanged, *all* of
   them remain live.  This should result in an update realizing the same
   degree of cell parallelization that the initial evaluation could exhibit.

 * A system might speculatively recalculate cells that might not remain
   live.  When performing speculative execution, we should expect faults or
   non-termination, since recalculating non-live nodes is equivalent to
   executing otherwise-unreachable code.


### Liveness and Lifetimes

After an update, any dead cells (those no longer in the dependency graph)
can be discarded.

Any system-level resources associated with them can be freed automtically,
without any explicit resource managment on the part of the programmer.  In
particular, any registrations for notifications (e.g for input cells) can be
canceled, ensuring deterministic cancellation of notifications when they are
not needed.

Finally, note that aside the result and values it references, no allocations
performed during execution of that cell can be referenced outside the cell.
If cell results are copied "out of" the cell on completion, perhaps in the
process of interning or persisting to disk, then all memory allocation
during execution of a cell can be discarded.  This might point the way to a
form of automatic memory management without reference counting or
mark-and-sweep garbage collection.  It would be analogous to how a C
compiler could be written to never call `free()`, knowing that once it exits
all its memory will be reclaimed by the OS.  A compiler that "leaks" memory
can be part of a robust, long-lived build *system* that, as a whole, does
not leak memory.


### Equality

Functions do nat have *identity* in Rio as they do in JavaScript and many
other imperative languages that incorporate functional concepts.

We will, however, need to compare functions for the purpose of memoization,
checking dependencies for changes, and serialization.  In these cases, we
will use some notion of *intensional* equality when comparing functions:
functions are equal if they share the same internal structure *and* their
captured variables have equal values.  The definition of "structure" left
somewhat loose for now, but the key requirements that must be met are: (1)
intensional equality must imply extensional equality ("when two functions
are 'equal', they must behave the same, but not necessarily vice versa"),
and (2) if the program text has not changed, then two instances of the same
source expression with the same captured values must be equal.

It is not clear whether function comparison needs to be exposed as a
user-facing feature.  Perhaps function comparison is available only at a
"meta-evaluation" level, where code executing "outside" a program deals with
AST and IL representations and other VM structures, invokes the VM to
evaluate it, and is invoked by the VM to implement extensions.


### Cell Construction Options

Ultimately, cell behavior could be customized in various ways.  The system
may provide options to constructors for cells that differ along these
dimensions:

 * Cache Lifetime
    - Default: discard when not used within an update
    - Alternate: discard when not constructed
    - Grouped: associated with a pool object
    - Persistent: saved to disk for future program invocations

 * Cache Variance
    - Default: one result per cell
    - Variant: different results for different input values

 * Memoization scope
    - Default: all cells
    - Local: per-constructing cell [optimization potential]
    - None.  Construction always creates a new cell.  [Still useful for
      filtering changes to reduce parent recalc.]

 * Evaluation
    - Default: lazy, on-demand
    - Parallel: begins on creation, not on use
    - Strict (just for completeness, to keep ordering orthogonal to caching)

 * Blocking
    - Default: blocking
    - Non-blocking: evals to Pending prior to completion

 * Validation strategy
    - Default: full comparison
    - Dirty: assume recalc==change [For some cells, invalidation is always
      followed by a new value, so comparison is pointless.]


## Appendix


### The Notification Problem

The traditional conception of a "program" in computer science is one that
receives inputs, yields outputs, and then terminates.  However, many if not
most software systems in existence are long-lived, and respond to external
events.  These external events trigger changes in the internal state that
propagate to varying degrees throughout the system.

Here we highlight ways in which complexity, bugs, and inefficiencies can
arise from following the prevailing methods for dealing with change, like
the [observer pattern](#https://en.wikipedia.org/wiki/Observer_pattern).
Let's start with the immediately visible costs:

 * More Code: Objects must register for notifications when they use
   information that is subject to change, and later de-register.  Likewise,
   code is needed to implement registrations (and de-registration).

 * Repeating Ourselves: The logic for maintaining an object's state is split
   between its constructor, which initializes the state based on observed
   objects, and event handlers, which update the state in response to
   notifications. The constructor embodies the essential behavior, while
   handlers redundantly maintain it. A programmer will infer handler logic
   from the constructor, highlighting that handlers are a workaround for
   limitations in the programming paradigm.

 * Bug Potential: Managing incoming notifications and updating local state,
   as well as producing precise and thorough notifications, is non-trivial
   and can heighten the risk of bugs.

Now we consider some of the more subtle, systemic problems.  Assuming the
programmer does all of the above flawlessly, the resulting software will
still suffer from the following:

 * Fan-out Explosion: One object's notifications can fan out to multiple
   other objects.  These, in turn, can propagate to multiple other objects,
   multiplying in number at each step.  This effect, amplified by diamond
   dependencies (where mutiple paths of notification converge), can lead to
   an exponential increase in notifications as the system grows.

 * State Inconsistency: As notifications from observed objects are delivered
   independently, not simultaneously, a notified object might temporarily
   encounter a mix of updated and not-yet-updated dependencies, potentially
   leading to errors or incorrect behavior.

 * Complex Lifetime Management: Registering callbacks in the observer
   pattern creates reference cycles, entangling an object's lifetime with
   others, typically including longer-lived objects. Even in environments
   with garbage collection and weak references, deterministic cleanup of
   system resources requires explicit lifetime management, adding a burden
   to the codebase.  Furthermore, explicit lifetime management is a
   contagious requirement, propagating to other parts of the codebase that
   interact with these objects.

 * Coalescing: Often external events can come in bursts, or arrive faster
   than they are being processed.  A robust architecture would allow some
   changes to be accumulated or coalesced into a single notification.  This
   introduces varied notification types, adding code complexity and
   potentially worsening inconsistency issues.

 * Error Handling: With our logic spread across multiple functions, we now
   have multiple calling contexts in which to deal with exceptions and
   errors. An uncaught exception in an event handler can have unpredictable
   effects, often requiring drastic measures like process termination to
   minimize adverse repercussions.

These issues provide both motivation for pursuing an incremental reactive
approach, and insight into how it should work.  We ultimately need some form
of orchestration that allows notifications to be queued and delivered
asynchronously while ensuring that each component receives and processes its
notifications only after all its dependencies have processed theirs.
