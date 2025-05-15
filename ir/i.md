# i.js

`i.js` is a library that enables constructing software using Incremental
Reactive Evaluation in JavaScript.

The conceptual model for IRE is described in ..doc/incremental.md.  This
library provides JavaScript analogs for those primitives and supporting
functionality.  Note that implementing IRE in JavaScript can be challenging
and at times baffling.  The user should become very familiar with the
conceptual foundation (as described in incremental.md) and with all the
potential [pitfalls](#javascript-pitfalls).


## Synopsis

    use(VALUE)               // force evaluation
    tryUse(VALUE)            // force evaluation and catch errors
    bake(FNX, CAPS)          // construct durable function
    ebake(EFNX, CAPS)        // construct durable function with empty arg list
    lazy(EFN)                // construct lazy thunk from function
    defer(EFNX)(CAPS)        // == lazy(ebake(EFNX, CAPS))
    cell(EFN)                // construct cell from function
    wrap(EFNX)(CAPS)         // == cell(ebake(EFNX, CAPS))
    memo(EFNX)(CAPS)         // == use(wrap(EFNX)(CAPS))

    lazyApply(FN, VALUE)     // apply lazily to lazy values
    deferApply(FN)(VALUE)    // apply lazily to lazy values (durably)

    // streams
    stream.newStream()
    stream.filter(f)(s)
    stream.map(f)(s)
    stream.fold(f,z)(s)
    stream.flatMap(f)(s)

    // low-level API
    isThunk(VALUE)           // detect thunkness
    state(VALUE)             // construct a state cell
    onDrop(FN)               // register a cleanup function


## Orchestration Primitives


### JavaScript Types

Cells and lazy thunks are **thunks**, instances of the `Thunk` class.
This is used to distinguish them from fully-computed values.

In Rio, "value" refers only to the final, computed result of an expression,
and user code cannot distinguish between thunks and results.  "Term" refers
to what a variable might be bound to during evaluation: either a computed
value or a thunk.  In JavaScript, thunks are visible to user code.
**Values** include thunks, and we sometimes say "result" or "computed value"
to distinguish non-thunk values.

Functions can be [durable functions or nonce
functions](#function-equivalence).  Thunks will likewise be durable or not,
based on how they are constructed.


### Forcing Evaluation

In Rio, computed values and thunks are interchangeable and forcing
evaluation is implicit.  In JS, we have to explicitly call `use` to force
evaluation.  Thunks *can* be used interchangeably with computed values, but
only in those situations where the consumer is careful to call `use`.

 * `use(term)` : if term is a thunk, force its evaluation and return the
   result.  Otherwise, return it unchanged.

### Durable Functions

 * `bake(FNX)(...CAPS)` : construct a durable function.

        FNX = (...CAPS) => (...ARGS) => BODY
        result = (ARGS) => BODY

 * `ebake(EFNX)(...CAPS)` : construct a durable function with empty arglist.

        EFNX = (...CAPS) => BODY
        result = () => BODY

### Lazy Thunks

 * `lazy(efn)` returns a lazy thunk.  `efn` is a function with an empty
   parameter list.  If `efn` is durable, the resulting thunk will be
   durable.

   Unlike lazy evaluation in Rio, its result is not cached (there is no
   at-most-once evaluation guarantee).

 * `defer(efnx)(...)` is equivalent to `lazy(ebake(efnx, ...))`.

### Cells

 * `cell(EFN)` constructs a cell.  If expr is durable, the resulting cell
   will be made durable.  `EFN = () => BODY`

 * `wrap(EFNX)(...CAPS)` is equivalent to `cell(ebake(EFNX,...CAPS))`.

 * `memo(EFNX)(...CAPS)` is equivalent to `use(wrap(EFNX)(...CAPS))`.
   Another way to think of this is that `memo(FN)` is like
   `intern.memoize(FN)`, except that is it safe to use with functions that
   use cells.


### ?

 * `onDrop(FN)` register FN to be called when the current cell is
   recalculated or discarded.  This can be used to release resources that
   were retained for the purpose of maintaining the cell, such as listeners
   or network connections for input cells.



## Imperative Code

Code constructed with `i.js` will execute in one of two domains:

**Reactive Domain**: Reactive code runs within the context of a cell update,
and is an analog of how Rio code would execute.  It should remain *pure*,
avoiding side effects and internal state.  It should not communicate with
other cells, or cause invalidations of other cells, except via `use`,
`cell`, and `wrap`.  Otherwise, it might interfere with the proper
functioning of the update algorithm.

**Imperative Domain**: This refers to execution outside of the context of a
cell update.  Code in this domain plays a part in connecting the reactive
environment to the outside world.


### State Cells

`state(initialValue)` constructs a state cell.  This cell may be constructed
and its value may be obtained (via `use`) in either domain.

`cell.set(newValue)` can be used to modify the value of a state cell.  This
must not be called within the reactive domain.  If it is, a fatal error will
be thrown.


### Root Cell

When JavaScript begins execution, and when JavaScript callbacks fire, code
is executing outside of the context of any IRE update operation. The library
create a cell called the **root cell** and treat it as the current cell when
code is executing outside of any user-constructed cell.

This root cell is different from other cells.

 * It does not produce a result, so no other cell depends on it.
 * It cannot be "recalculated", for obvious reasons.
 * Cells created by it will be retained indefinitely.
 * Cells used by it will remain *live* and be continuously updated.
 * The root cell is self-updating, using `setTimeout` to trigger updates
   of its dependencies.

Having a root cell enables IRE primitives, and functions built on them, to
be called during module loading.  Even though the functions are written to
deal with *potentially* varying inputs, they can be used to construct
unchanging values.

If any of cells used by the root cell return values other than
null/undefined, a warning is written to the console.  If any of them throw
an error, the error will be reported, which will terminated program
execution in a command-line environment.

Cleanup functions that are registered with `onDrop(f)` in the root context
will generally not ever be called.  This is appropriate for resources that
have the lifetime of the entire program.


### Root Children

Currently, imperative code can call `use` to place a cell in the input set
of the root cell, making that cell *live*, ensuring it will be updated.

Likewise, imperative code can call `cell.deactivate()` on such a cell,
removing it from the root's input set.

In the simplest case, a single child-of-root is created to fill a DOM node
with content, and it remains live until the browser window is closed.


## JavaScript Pitfalls


### Impure Functions

We need to ensure that our functions, including cells, are pure functions,
and will return the same value every time they operate on the same inputs.


### Data Equivalence

The library must perform equivalence tests on (a) cell results, and (b)
inputs to memoized functions (including cell construction parameters).

One challenge is that JavaScript compares composite values like objects and
arrays by *identity*.  This is appropriate for a language in which these
values are mutable, but we need to avoid mutation of cell results after they
have been returned, and using identity-based comparison would mean that a
recalculation would *always* return a new value when the cell constructs an
array or object.  So we need to compare these objects by their contents.

Our solution is based on `intern.js`.  Cell construction arguments are
interned before use, and cell results are interned before given to cells the
use them, so comparison using `===` effectively compares by value.
Interning currently works with:

 - Arrays

 - Simple objects (those whose constructor is `Object`, which include object
   literals)

 - Primitive types: string, number, boolean, null, undefined.

For other objects, including functions, `intern` just returns the value
unchanged.  Developers must take particular care using these values with
cells.


### Function Equivalence

Every time a JavaScript function expression is evaluated, it produces a new
instance.

   let f1 = () => m*x + b;
   let f2 = () => m*x + b;
   f1 == f2;  // false

For our purposes, we call these **nonce** functions: the results of function
expressions evaluated within a cell.  On recalculation, a different result
will be produced.

**Durable** functions work the same as equivalent nonce functions, but they
can be compared meaningfully using either `===` or `==`.

Cells and lazy thunks can likewise be durable or nonces.  For a thunk to be
durable, it has to be constructed from a durable function or thunk.

To create a durable function we separate the unchanging code part of the
function from the captures that might change during recalculation, and then
we combine these with a library-provided function, either `bake` or `ebake`.

Converting a nonce function to a durable function requires some rewriting.
We first identify the free variables in the function body.  We then define
an "external" function that accepts those variables as arguments and simply
returns our original nonce function, now the "internal" function.  Then
`bake` is used to construct the durable function.

   let funcX = (m, b) => x => m*x + b;

   let f1 = bake(fX, m, b);
   let f2 = bake(fX, m, b);
   f1 == f2;  // true

More generally, for any function expression:

    (ARGS) => BODY

we define an external function:

    const FNX = (CAPS) => (ARGS) => BODY;

This external function definition must be evaluated only once, so the
top-level of module is a good place for it.  Think of `CAPS` as the
list of values that FNX needs, because they are not known where and when
FNX is defined.  We combine them at run time to construct the durable
function:

    bake(FNX, CAPS)

What `bake` does, essentially, is call a *memoized* FNX with CAPS.
Memoization ensures that subsequent calls with the same arguments will
return the same value without re-evaluating the body of the function.

When using `i.js`, we commonly define functions with empty parameter lists
to construct thunks.  For these cases, `ebake` makes construction a little
simpler than bake:

    cell(() => BODY)                       // nonce cell

    cell(ebake(EFNX, CAPS))                // durable cell
    const EFNX = (CAPS) => BODY;           // external fn definition

    cell(bake(FNX, CAPS))                  // durable cell (alternate)
    const FNX = (CAPS) => () => BODY;      // external fn definition


#### Transitivity of Durability

When `bake` is called, it uses the values of all its arguments to index a
cache of previously-created durable functions.  If any of these values are
nonce values, then the lookup will fail, even when the "values" of all
arguments are equivalent.  Any functions or thunks passed to `bake` as
"captures" must be durable in order for it to produce a durable result.


#### When is it okay to use a nonce?

Generally speaking, durable values are preferred since they avoid
unnecessary recalculation.  Sometimes, however, the cost of recalculation
might be trivial, or outweighed by the expense of memoization.  Here are
some example situations:

 * A very lightweight cell, like this filter:

       let hour = use(I) / 3600;   // unfiltered => recalc per second

       let hour = use(cell(() => Math.round(use(I)/3600)));   // filtered

 * A nonce function used to create a cell that would not be durable anyway.
   For example, `e.js` creates and uses cells to set properties (when
   provided as a thunk) for elements it has created.  Since the setProperty
   cell acts on a DOM element, which is itself a kind of nonce created by
   its using cell, it cannot outlive its using cell, so it might as well be
   constructed with a nonce function.

 * Terms being passed to a nonce cell.  Nonce cells are not memoized, so
   their creation parameters do not need to be tested for equality.  For
   example, since the setProperty cell (described above) is a nonce, the
   property values might as well be specified as nonce thunks, rather than
   durable ones.

The last two examples refer to a situation that exists only because of an
architectural weakness of e.js -- one that must be fixed at some point -- so
these are not indications of a general pattern one should expect to find.
These are mentioned here only because you may encounter it when using e.js.


### Debugging

Debugging i.js-based code presents interesting challenges.

Order of evaulation is not what you would see with an ordinary JS program,
so uncaught errors can present confusing stack traces.  There are a few of
reasons for this.

  * Both cells and lazy thunks separate construction from evaluation; the
    function that constructed it might not appear in the stack trace.

  * Incremental updates recalculate only invalid cells, so when a cell is
    executing, the stack trace might include neither the cell that
    constructed it nor any cell that used it.

  * When there is an uncaught error within a cell, the framework catches the
    error and records it as the cell's result.  When a cell in such an error
    state is used, the error is rethrown, with a stack trace showing the
    `use` of the cell, and a JS error "cause" showing the original error
    within the cell from the time the error occurred (which have been in a
    previous update in which the error was caught and handled).
