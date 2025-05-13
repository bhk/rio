# Incremental Reactive Evaluation

## Introduction

Spreadsheets and build systems manage large computations and automatically
recompute them efficiently when inputs change, reusing prior results when
they are not affected.  We intend to extend this idea to general-purpose
programming, eliminating the need to manually handle updates and
notifications. Consider the difference between a script generating a static
HTML report from database queries and a browser script rendering a live,
auto-updating version of the same.  Rio's Incremental Reactive Evaluation
(IRE) targets the simplicity of the former with the responsiveness of the
latter.  See [below](#the-notification-problem) for a deeper analysis of how
update complexity burdens modern software.


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

We now consider more concretely how IRE applies to programs in Rio.

TODO:
- **Value**: a fully computed result.
- **Thunk**: some deferred computation, one of:
   - **Cell**
   - **Lazy Thunk**
- **Term**: what a variable is bound to; either a **value** or a **thunk**.



### Lazy Evaluation

Rio uses strict, or applicative order of evaluation by default, but by
convention, when a function is called and the function name ends in `&`, its
arguments are passed lazily.  For example, in `f&( g(x) )`, the "lazy"
expression `g(x)` is not evaluated before `f&` is called.  Instead, `f&`
receives a lazy computation.

A function named just `&` returns its first argument without performing any
operation on it, so the result will be a lazy computation defined by that
argument.

No explicit code is required to force evaluation; any operation on the
contents of the value will force evaluation.  The lazy aspect does not
manifest in the type of the value.

Lazy expressions are evaluated at most once.  They are initially evaluated
whenever the program first operates on the lazy computation.  The result is
then cached, so if it is needed again the already-computed result will be
used.  To be clear, this at-most-once characteristic applies per-instance.
If the expression *constructing* the lazy computation is evaluated more than
once, multiple instances will result, each of which can be evaluated once.


### Constructing a Cell

The `memo&` function constructs a cell to contain an expression.

       v = memo&( f(x, y, z) )

Like lazy computations, cells are interchangeable with ordinary values, and
evaluation will be performed when-and-if necessary, automatically, without
any explicit code to that effect, and at most once.  They can be assigned to
variables and passed to functions without forcing evaluation.

Cell construction is **memoized**.  Instead of a newly constructed cell, it
might return an identical cell that has already been created, perhaps in an
earlier update, or earlier in the same update.  This is crucial to retaining
used cells across a recalculation of their using cell.  An "identical" cell
is one defined by the same expression and the same captures (bindings for
variables that are not bound within the expression).  See
[Equivalence](#equivalence), below, for more details.


### Using a Cell

The act of **using** a cell (obtaining its value) is distinct from
constructing a cell.

    x = memo&( f(7) )       # construct cell for f(7)
    y = f(9)                # evaluate f(9) now
    z = x + y               # evaluate x, mark x as a dependency

Whe code executing within one cell uses the value of another cell, the used
cell is tracked by the system as a dependency of the currently-executing
cell.  It is *use* of a cell, not construction of a cell, that adds nodes
and edges to the dependency graph.

From the dependency graph perspective, each cell is, abstractly, a function.
That is, it produces a result, deterministically, from its inputs.  However,
don't confuse this with "functions" in the programming language.  For
example, in the cell expression `memo&( f(x, y) )`, the values of `x` and
`y` are inputs to the Rio function `f`, but they are not inputs to the cell
-- they are instead part of the *identity* of the cell, which consists of
its *expression* and *captures*.  From the dependency graph perspective, the
only inputs to a cell are the other cells that it used while computing its
result.

In general, the shape of the dependency graph will not resemble the
structure of your program.  With IRE, your program's structure can continue
to be guided by the usual software considerations of modularity and
readability, whereas the structure of the dependency graph arises from the
dynamics of its execution.


### Lazy Semantics in a Reactive Context

The interaction between lazy expressions and IRE warrants some discussion.

Recall that the initial evaluation cycle of a Rio program is like that of an
ordinary functional program.  Each subsequent update is essentially the
same, except that it can skip evaluation of some cells, using their previous
result *as if* they had been re-evaluated.

As with many other functional programming assumptions, the notion of lazy
evaluation (and cell evaluation) as happening "at most once" do in fact
apply to Rio, but only within the scope of an update.

Consider the simple case of lazy computation that is constructed within a
cell and used only within the same cell.  The conventional semantics apply
to *each recalculation* of that cell.  During each recalculation, lazy
instances may be constructed, and each will be evaluated at most once.
IRE does not complicate things.

Now consider a lazy computation crossing a cell boundary.  Here there is an
opportunity for a lazy computation instance to outlive the udpate cycle that
created it.  This would happen, for example, if cell A constructs a lazy
computation, cell B uses it, and then on a subsequent update only cell B is
recalculated.  During this update, the lazy computation's previous (and
cached!) result could be stale (incorrect) if its evaluation involved
accessing some other cell that has since changed.  The system must track
dependencies in order to ensure that lazy cached results are discarded in
these cases, resulting in at-most-once-per-update evaluation.  (If the lazy
computation does not access any cells, we can have at-most-once-ever
evaluation.)

While lazy and cell evaluation have similarities, keep in mind the two
significant differences:

 - Isolation: A cell can isolate its users from dependencies.  Cell
   boundaries are our firewalls or bulkheads that prevent the spread of
   recalculation.  By contrast, a lazy computation that touches any external
   dependencies will expose its user to invalidation and recalculation,
   regardless of the result of the lazy computation.

 - Memoization: When `memo&(EXPR)` is evaluated more than once with the same
   expression and the same values bound to free variables, the same cell
   instance will result.  This remains true *across consecutive updates*, so
   a cell *can re-use cells that it constructs*.


### Cell Exceptions

Uncaught exceptions that occur during evaluation of a cell halt its
execution and put the cell in an error state.  As with errors in lazy
computations, errors in cells will propagate up the call stack from where
the cell is used, not from where it was constructed.  These errors can be
caught by wrapping the point of use in `try&( ... )`.


### Streams

TBD


### Action Objects

TBD


### Reactive I/O

Incremental Reactive Evaluation enables an elegant way to support some I/O
operations in a function language without side effects without blocking the
thread of execution, and without the need for callbacks or "monadic"
constructs.

We start with I in I/O.  A data retrieval can be represented as a function.
It might involve "under the hood" mutable operations, but the behavior
visible to the program can be defined in a pure functional way, respecting
referential transparency.  For example:

    data = IO.load("http://example.com/data.txt")

The result reflects the result of the retrieval.  As with IRE semantics in
general, of course, this includes the possiblity that the result might
change over time.


#### Reactive Waiting

A big complication with IO operations is that they can take indeterminate
amounts of time, and we don't want this to *block* evaluation of our
program.

In a reactive system, we can sidestep this problem by allowing the operation
to return a variant result -- `Pending | Ready(value)` -- either the
operation outcome (be it success or failure), or a special value that means
the outcome is not yet known.

Initially, the operation will evaluate to Pending, and the caller can take
appropriate action and then the rest of the program can continue to be
evaluated.  When the retrieval is complete, the operation's result
changes to `Ready(value)`, and the caller is recalculated.


#### Pending as an Exception

Often, a calling function will not have anything meaningful to do with a
Pending result, and being unable to complete its own task, it will also
return a Pending result to its caller.  This can repeat again, up the call
chain.  Ultimately, somewhere downstream will be the appropriate place to
handle the pending nature of the computation, perhaps in the UI where the
incomplete nature of the operation can be visually indicated, but sadly all
of the code in between incurs the additional complexity of dealing with
variant results without being able to provide additional value.  This
requirement is contagious, and could permeate the code base.

For this reason, instead of using variant results, we generally communicate
pending conditions with an exception.  An operation "throws" a Pending
exception when its completion awaits IO operations, and whomever is
interested in handling that condition can catch the exception.  All of the
intervening code can be oblivious to pending operations, just like code
written assuming blocking semantics.  When a retrieval operation completes,
the oblivious code will be recalculated, and then run to completion instead
of being interrupted by an exception.


#### Cell Splitting

As discussed above, when one or more of a cells inputs change, the cell will
be recalculated.  You might observe that this update will involve some
computation that will *not* change: namely, every step of computation that
happens *before* it consumes the first changed value will be -- *must* be --
exactly the same as on the previous update.  You might also note that a
language implementation tailored to IRE *could* make note of the internal
state of the cell when it uses another cell -- call them "continuation
points" -- so that subsequent recalculations can begin from precisely the
point where the first changed result was observed.

If we were to represent this in the dependency graph, each cell would appear
as a sequence of one or more nodes: an initial node, which operates only on
the cell's creation parameters, and then one node for each of its inputs.
The first node has no inputs, and subsequent nodes have exactly two input:
one is the prior node, and the other is the cell being used.  The final node
in the sequence produces the cell's output.


#### Blocking Threads

Now consider what happens when the cell uses another cell that is in an
exception state, such as Pending.  As discussed above, this is equivalent to
throwing an exception within the cell.  In particular, consider the case
where the exception is not caught within the cell.  This cuts short the
execution of the cell at the point where the exception is thrown, which is
also a point where an input was accessed.  In order for a language
implementation to keep track of this continuation point, all it has to do is
leave the stack in its final state (assuming we assign the cell its own
stack).

Now, if that pending operation transitions to a ready state, this
cell-splitting-optimized recalculation of the cell would simply resume
execution of the cell at the point where it was cut short by the Pending
exception.  In this case, "recalculate downstream nodes" is the same as
"resume the thread from where it was blocked".  In this regime of operation,
where cell state transitions are from Pending to Ready, this IRE model
converges with a traditional blocking multi-threaded execution model.

But the difference is: here, we can essentially "catch" the "thread
suspension", just like any other exception.  And catching that condition
does not prevent the "thread" from being resumed.


#### The O in Reactive I/O

Being a functional approach, IRE conveys outputs with computed values, not
side effects.  What exactly this looks like depends upon the context.

In the browser, for example, a program generates a description of what
should be displayed to the user, and returns this value to the system, which
proceeds to "make it so".  This will involve many mutations of the DOM tree.
As inputs change over time, and the program's computed description changes,
this causes the system to apply further changes as necessary to have the DOM
tree reflect the new results.

In a command-line program, a program will generate an action object.  This
is an object, like a promise in JavaScript or the IO Monad in Haskell, that
describes an action to be performed by the system, and a subsequent function
to be called to obtain the next action object.

An event handler in the browser exemplifies both input and output.  It
translates a user event into an action object.  The action object it
generates could describe changes to state cells that will trigger
recalculations, or changes to the outside world.

[TBD: Maybe instead of action objects, a stream of events is a better
match.]


## Implementation Notes


### Minimal Update Algorithm

Here are a couple of requirements that we would like the update algorithm to
satisfy:

1. Minimality: Only **invalid** and **live** nodes shall be recalculated,
   and each node should be recalculated at most once.  By invalid, we mean
   that its dependencies have changed.  By live, we mean that it is in fact
   used in this update, and will remain part of the dependency graph.

2. Consistency: The resulting graph and values shall match what would result
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

 * Dependencies used in parallel threads of execution are not ordered with
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

Comparison of values is crucial to IRE in a couple of ways:

 - Validity of a cell is determined by comparing current inputs with their
   previous values.

 - Memoization of cells (finding an existing, equivalent instance) requires
   comparing the cell expressions used to construct them (and the values
   those expressions reference).

However, to be more precise, we are not actually talking of "value" in the
ordinary functional programming sense, because "thunkness" (lazy-ness and
cell-ness) matters.  In other words, while `f(x)` and `&(f(x))` and
`memo&(f(x))` evaluate to the same *value* and *are* the same,
denotationally, they are not the same thing for IRE purposes.

Cells and lazy computations need to be compared with each other, which
brings up the question of comparing expressions and functions.  In pure
functional languages, function comparison is generally not supported,
because *extensional* equality is not computable.  In many imperative
languages that incorporate functional concepts like closures, function
references can be compared, but these deal with instances, and any two
instances are considered unqeual, which is unhelpful to us.  We need some
notion of *intensional* equality when comparing functions: functions are
equal if they share the same internal structure *and* their captured
variables have equal values.  The definition of "structure" is left somewhat
loose for now, but the key requirements that must be met are: (1)
intensional equality must imply extensional equality ("when two functions
are 'equal', they must behave the same, but not necessarily vice versa"),
and (2) if the program text has not changed, then two instances of the same
source expression with the same captured values must be equal.

It is not clear whether the ability to compare functions and test thunkness
needs to be exposed as a user-facing feature.  Perhaps there are only
available at a "meta-evaluation" level, where code executing "outside" a
program deals with AST and IL representations and other VM structures,
invokes the VM to evaluate it, and is invoked by the VM to implement
extensions.


### Cell Construction Options

Ultimately, cell behavior could be customized in various ways.  The system
may provide options to constructors for cells that differ along these
dimensions:

 * Cache Lifetime
    - Default: discard when not used (at end of update)
    - Alternate: discard when neither constructed nor used
    - Grouped: lifetime associated with a pool object
    - Persistent: saved to disk for future program invocations

 * Cache Variance
    - Default: store only most recent result
    - Variant: store different results for different input values

 * Memoization Scope
    - Default: all cells
    - Local: per-constructing cell [optimization potential]
    - None.  Construction always creates a new cell.  [Still useful for
      filtering changes to reduce parent recalc.]

 * Evaluation
    - Default: lazy, on-demand
    - Parallel: spawn on creation, wait on use
    - Strict (just for completeness, to keep ordering orthogonal to caching)

 * Blocking
    - Default: blocking
    - Non-blocking: special values convey partial results prior to completion

 * Validation Strategy
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

 * Repeating Ourselves: The logic for maintaining an object's state involves
   its constructor, which initializes the state based on observed objects,
   and event handlers, which update the state in response to
   notifications. The constructor embodies the internal structure and its
   meaning, to which handler code attempts to stay true.  One can imagine
   handler responsibilities being automatically inferred from a constructor.

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
