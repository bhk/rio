# Rio Concept Map

This is a collection of notes on goals, rationales, design ideas,
implementation ideas.  Beware that most statements about "Rio", what it
does, and how it does it, are aspirational.

This is a non-linear document, not necessarily read from top-to-bottom.
Each section has hyperlinks to other sections that provide necessary
background.

----


## Rio Overview

The following list of ingredients can give one a feel for the flavor of Rio.

 * [Immutability](#immutability)
 * [Lexical scoping](#lexical-scoping)
 * [Duck typing](#duck-typing)
 * [Imperative Syntax](#imperative-syntax)
 * [Early Evaluation](#early-evaluation)
 * [Friendly Data Types](#friendly-data-types)
 * [Typed Structures](#typed-structures)
 * [Reactive Programming](#reactive-programming)
 * [Order Annotations](#order-annotations)
 * [Pattern Matching](#pattern-matching)
 * [Gradual Typing](#gradual-typing)

Think of a mix of Lisp and Smalltalk, but without mutation.  And with some
Python-like syntax.  And with an implementation that heavily leverages
inlining and early evaluation.


## Syntax Introduction

Here is a quick summary of Rio's "inline" syntax:

 - Numeric and string constants:  `1`, `1.0e4`, `"hello"`
 - Variables: `x`, `foo_bar`, `FooBar`
 - Infix expressions:  `a + b * c`
 - Prefix operations:  `not a`,  `-x`
 - Function construction: `(x) -> x * 2`
 - Function application: `f(x, y)`
 - Vector construction: `[x, y, z]`
 - Vector de-reference: `a[1]`
 - Map construction: `{a: 1, b: 2, c: 3}`
 - Property de-reference: `r.prop`

Refer to [`syntax.md`](syntax.md#grammar) for all the gory details.

Rio's "block-level" syntax involves multiple consecutive lines of code,
structured using [indentation](#2d-syntax).  Block-level syntax enables:

 - Assignment expressions
 - Conditional expressions
 - Imperative expressions
 - Match expressions

For example:

    f = (a, b) ->
        if x < 1: 0
        total = 0
        loop while x < 10:
            total += x
            x += 1
        total

Other syntax features:

 * [Vertical syntax](#vertical-syntax)
 * [Imperative Syntax](#imperative-syntax)
 * [Pattern Matching](#pattern-matching)


## Imperative Syntax

A number of features that resemble imperative programming, but without the
pitfalls of mutable data, are implemented as syntactic sugar.

 * [Update Syntax](#update-syntax)
 * [Looping Syntax](#looping-syntax)
 * [Action Syntax](#action-syntax)


## Vertical Syntax

Rio syntax supports a "vertical" program structure, so that code reads down
the page instead of diagonally down and to the right as in some other
functional languages.  Likewise, data flow (during execution) generally
progresses down the page, which can help in visualizing and understanding the
code, as well as authoring in a worksheet-based [live
programming](#live-programming) environment.

Assignment expressions consist of a `NAME = EXPR` line followed vertically by
a `BODY`.  The assigned variable is visible only in the body, not in the
RHS of the assignment.

Conditional expressions consist of `if COND: THEN-EXPR` followed vertically
by `ELSE-EXPR`.  Each "logical" line can be split across physical lines by
indenting the continuing lines.

For example, the following Lisp code:

    (if P
        A
        (if Q
            (let ((x EXPR))
                (* x x))
            B))

... is equivalent to the following Rio code:

    if P: A
    if Q:
        x = EXPR
        x * x
    B


## Pattern Matching

A `match` expression selects between multiple alternatives, potentially
de-structuring aggregates and binding names.

    match Value:
       Pattern => Expr
       Pattern => Expr

A `Pattern` can be one of the following:

 - Name: A name matches any value.  When the corresponding `Expr` is
   evaluated, the value is bound to the variable of that name.

 - Constant: A literal number or string will match an equivalent value.

 - `[Pattern, ...]`: A sequence of zero or more comma-delimited patterns
   enclosed in `[` and `]` will match a vector value if it has the same
   length as the pattern expression and if each pattern matches the
   corresponding element in the vector.

The value of the `match` expression is the value of the expression
corresponding to the first matching pattern. If none of the patterns match,
an error occurs.

In the following example, the fourth pattern is the first to match,
resulting in a value of 6.

    match [1,2,3]:
        [a, b, c, d] => 1
        [a, b] => 2
        [2, b,c] => 3
        [1, b, c] => b * c


## Methods and Properties

Values may have properties and methods.

The `.` operator is used to obtain properties.  For example, `value.name`
evaluates to the `name` property of `value.`

A "method" is nothing more than a property that evaluates to a function.
The expression `a.foo()` is equivalent to `tmp = a.foo; tmp()`, exactly as
logic would dictate (but unlike as in some other programming languages).

Rio does not confuse properties with members of collections.  Indexing
expressions -- e.g. `value[index]` -- access members of a vector or map, not
their properties.

Rio's infix operators are defined in terms of properties.  Assuming a
hypothetical function called `get_property` that allows direct access to all
properties...

    x + y    <==>   get_property(x, "{}+")(y)

Member access is done via a property:

    a[k]     <==>   get_property(a, "{}[]")(k)

Properties express essentially all of the behavior of a value, except for
function invocation.

Abstract data types are constructed by providing an implementation of
`get_property` for that type.

    gp = (self, name) -> ...
    new_type = derive(old_type, gp)


## "Compile Time"

Compilation is an overloaded term, referring to a number of separate issues
that go together in traditional languages, but not necessarily in Rio:
static analysis, code generation, and construction of an "object" file.

Compilation usually involves some amount of static analysis.  We will call
this static analysis, and not compile-time analysis, and define it as the
analysis that is done by examining the program alone, without any knowledge
of inputs that the program might encounter in the future.  Note that, given
the nature of worksheets, much of the actual execution of the program might
occur at "compile time" in this sense.

Compilation and code generation are often thought of as synonymous -- and in
fact code generation is typically the biggest part of a "compiler".  In Rio,
however, code generation can happen after a deployable image is generated,
and after user input has been consumed, similarly to how a JIT-based VM
works.

Originally, compiling meant producing an object file: a deployable
executable image.  In a Rio *worksheet*, the user sees the results
immediately as the program is modified.  There is no executable image to
see.  Rio can generate deployable executables, but that step should be seen
as just deployment.

The traditional sharp distinction between compile time and run time is
reflected in terms like "compile-time evaluation" (CTE).  It is important to
note that in Rio, [early evaluation](#early-evaluation) provides the
benefits of CTE.

This lack of a sharp distinction between compilation and interpretation is
not merely an implementation choice.  It simplifies the *language* itself by
avoiding the notion of [top-level code](#top-level-code) and compile-time
primitives like `#ifdef`.


## Top-Level Code

Some languages distinguish "top-level" code from code that occurs within the
body of a function.  This complicates the mental model of the language.

For example, in C or Rust, the expressions that are valid in top-level --
e.g. on the RHS of a global variable definition -- are a subset of the
expressions valid within a function.  The visibility rules for functions and
variables defined at the top level are different from those defined within a
function's body.  In Rust, this means that the programmer cannot rely on
type inference for globals, and must explicitly declare types.  More
generally, user functions cannot be called in top-level expressions, so
construction of complex data structures must be done after `main` is called.

In dynamic languages such as Lua, JavaScript, and Python, top-level code is
not special, it is the same as function body code.  Loading a module
executes the body of the module.

Rio follows the dynamic language model.  One might assume that this comes
with a performance penalty, but that is not necessarily so.  With [early
evaluation](#early-evaluation), much of the computation can be done at
[compile time](#compile-time).  For example, modules can be discovered,
loaded, and evaluated.  Module return values, such as exported functions,
are typically constant, allowing their returned functions to be directly
linked with call sites, or even inlined.  [Inline tests](#inline-tests) can
be executed.  Dead code, such as conditionals based on constants, can be
eliminated.


## Observer Pattern

In a most programming languages, callbacks (typically using the observer
pattern) are used to enable propagation of changes between components.  This
comes with a number of drawbacks that may or may not be evident at the
outset:

 1. Work.  Code must be written to register for various type of changes,
    and to deregister, and on the notifying side to accept registrations and
    de-registrations and to deliver notifications at the correct times.
    Also, code must be written to receive the notifications (perhaps
    different kinds of them) and correctly update the component's internal
    state.

 2. Cycles.  Applied naively, this pattern introduces reference cycles into
    a program, so it requires strategies and techniques for avoiding memory
    leaks.  Even in languages with garbage collection, this introduces a
    resource lifetime management problem.

 3. Inconsistency.  Changes to the state of an object necessarily take time
    to propagate to downstream objects (notification callbacks must be
    called, and the notified objects must perform some work to update its
    state).  Whether an observer updates its state (synchronously *or*
    asynchronously) it still exists for some time in a state that is out of
    synch with the object it observes, and likewise, other objects in the
    system may be in such a state. (Perhaps they have not yet been notified
    because their callback was further down the list.)  The question arises,
    then, which methods of an object are "safe" to call in such a state,
    and, if not *all* of them, how can we ensure that we don't perform an
    unsafe call?

 4. Performance.  When the graph of objects includes diamond-shaped
    dependencies, a single notification can multiply as it propagates
    through the dependency graph.  This can lead to an explosion in
    computational complexity in a large graph.  Additionally, some
    programmatic changes to a component, such as processing a bundle of
    updates from a server, can result in many notifications.  As a result, a
    single change to the system -- for example, when a user clicks a button
    -- might require thousands of notifications to be processed.

"Invalidation" and asynchronous update can be employed to address the
performance problem, but this exacerbates the inconsistency problem.  I feel
that thorough contemplation of all these problems together drives one toward
a coherent paradigm wherein updates are orchestrated such that each
component can receive and processes its notifications all at once after all
its dependencies have processed theirs.  Looking at this abstractly, such a
paradigm resembles the way [build systems](#build-systems) work, and also
[reactive programming](#reactive-programming).


## Reactive Programming

Reactive programming allows us to deal with time-changing values implicitly,
rather than explicitly.  Instead of, as in the [observer
pattern](#observer-pattern), where we might write a class that computes its
internal state and then monitors changing inputs and responds to them, with
reactive programming we write a function that computes a value.  When the
inputs change, the language recognizes which values have been invalidated,
and performs what computation is necessary to recompute the new result.

The observer pattern is just one approach, but (due to its drawbacks) it is
not a universal solution, and programmers generally employ a number of other
ways to propagate changing data over time, like "stream" or "socket"
interfaces.  Given the possible design decisions, these can differ in many
ways: Does it use a pull vs. push approach? Are notifications synchronous or
asynchronous? Do notifications carry a payload?  When connecting components
that use different approaches, code must be written to address the
"impedance mismatch".  By providing a consistent, universally-applicable
approach, reactive programming can further simplify our programs.

When we do not have reactive evaluation built into the language, we can
attempt to tackle reactive programming with a library.  While this has had
success -- especially when tackling components such as UI views that where
the benefits are significant -- it requires the programmer to write code in
a stylized manner, maintaining a high level of awareness of how the library
works and avoiding things that would violate the abstraction.

In Rio, we see reactive programming as a special case of [incremental
evaluation](#incremental-evaluation).  We use the term "reactive" to refer
to cases where the changing values come from outside our program,
progressing with time, and re-calculation is entirely implicit -- an
alternative to the observer pattern or other such strategies.  Incremental
evaluation, more generally, allows a program to explicitly request
evaluation of a function and subsequent re-evaluations, controlling the
changes to inputs.  Incremental evaluation is used by the Rio language
infrastructure to to implement reactive evaluation in our programs.


## Incremental Evaluation

An incremental algorithm is one that can, after computing a result, compute
a new result more efficiently when not all of the inputs have changed.

With language support for incremental evaluation, we can avoid the need for
a programmer to manually write incremental variants of functions.

This idea does not require a magical, universal solution that optimally
handles arbitrarily complicated algorithms.  In order to be useful and
relevant, it only needs to be reasonably effective for the kinds of
functions we most commonly encounter in programming (searching, filtering,
transformation, etc.).  Even when some programmer involvement is required --
e.g. via [hints](#hints) that influence the granularity of recalculation --
it could still reduce the amount of programming work dramatically.

For (hopefully) obvious reasons, [incremental evaluation
](#incremental-evaluation) is easier to implement in a language with
[immutable](#immutability) data structures.


## Early Evaluation

*Early evaluation* refers to to performing computations "out of order", so
that we can avoid performing them multiple times.  We might compute a
sub-expression once before entering a loop, rather than per-iteration, or
once when a function is constructed, rather than every time it is called, or
once when compiling a program, rather than every time the program is
invoked.

For example, we can compute sub-expressions out of order when we know the
values of all of their dependencies.  For example, we can replace `1 + 2`
with `3`.  Cases like this involve applying the ordinary rules of evaluation
to a sub-expression.

When the value of a function is known, we can "inline" the function: replace
the a function application node with the body of the function, analogous to
a β-reduction in lambda calculus.  This avoids the overhead of the function
call, and, more importantly, it can enable early evaluation of
sub-expressions within the body of the inlined function.  Alternatively,
depending on the size of the function and other factors, we could generate a
call to a [specialized](#specialization) form of the function.

Even when we do not know the precise value of a dependency, we may have
some imprecise knowledge that will enable early evaluation.  For
example:

   - We might know its type.  This would allow us to perform method
     lookup at an early stage.

   - We might know that it falls within a set of possible values.  For
     example, it may be an integer from 0 to 100.

   - We might know that it is of a particular aggregate type, and know
     some of its members, but not all.  In this case, we might avoid
     code to extract a member from the value, and in turn maybe avoid
     the need to actually instantiate the aggregate.

Knowledge of values (precise or imprecise) can be gleaned by abstractly
interpreting an expression.  Constant expressions will have known values.
Conditionals and assertions in a program will restrict the possibilities in
subsequent paths of execution.

The fact that variables and data structures are [immutable](#immutability)
in Rio makes early evaluation particularly effective.  For example, the
functions imported by a module will generally be known statically, enabling
inlining or [specialization] of those functions.  This allows us to use
functions as [zero-cost abstractions](#zero-cost-abstractions).

Early evaluation is especially relevant to the language design of Rio
because it can predictably optimize away some overheads associated with
dynamic languages.  For example, when the type of a value is known, [method
lookup](#dynamic-dispatch) can be avoided.  This allows us to have "nice"
semantics without paying an unreasonable price.


## Specialization

A *specialization* of a function is a variant of the function this is only
valid for a subset of its input values.

For example, for `pow = (x, exp) -> ...`, we can generate a specialization
for the `(x: Number, exp: Number)` case, which would optimize away all
method lookups.  When generating code for a function that calls `pow`, if we
know that both arguments are numbers, we can emit code that directly calls
the specialized variant.  Otherwise, we can emit code that calls the generic
variant, which can check the `(Number, Number)` case at run time.

Specialized forms may be selected by the compiler based on its observation
of potential performance improvements, or based on heuristics such as
"always specialized by argument types".  Specializations can be compiled at
run time if we encounter variants that were not anticipated at compile time.
Programmer [hints](#hints) could override or guide the selection.


## Hints

Hints are statements in the code that do not affect the results of the
program, but may affect optimizations.

For example, a hint may suggest specializing code for values within a
numeric range.  E.g.  0 <= n <= 2^32.


## Profiling

We can observe execution of code to collect information and feed it back
into the compilation stage to direct optimizations.  Execution frequency can
point to where optimizations are worthwhile.  Observed data types and values
can suggest opportunities for [specialization](#specialization).


## Build Systems

*Build systems* optimize building large projects by enabling
[parallel](#order-annotations) and [incremental](#incremental-evaluation)
compilation of source files.  They allow a project's build to be described
as a tree, where each node corresponds to a source file or and output file
with an associated build step (e.g. compilation or linking), and where
parent-child relationships indicate data dependencies.

The same concept can be applied to problems other than software builds.  For
example, when processing large amounts of data in multiple stages, a build
system can be used to ensure up-to-date results while minimizing the amount
of time spent on needlessly repeating processing steps.

Typically, build steps are denoted by shell commands, and build systems rely
on the programmer to separately express the dependencies.  Using a build
system involves writing software in two ways -- the build system level at
the top, and one or more other languages that perform the individual
processing steps.

However, given a language that supports [parallel](#order-annotations) and
[incremental](#incremental-evaluation) evaluation, the benefits of a build
system can be had without dealing with two semantically mismtached languages
and paradigms.


## UI Development

Updating parts of the display as system state change typically involves
writing listener-related code: register for notifications, handle
notifications, de-register, handle registrations and deregistrations,
deliver notifications.

The amount of code required for a task is minimized by [reactive
programming](#reactive-programming).

The immediate feedback provided by [live programming](#live-programming)
makes the process of programming easier and more enjoyable.


## Live Programming

In live programming, the user can see immediately the results of code as it
is typed.

The implementation of such an environment could benefit from [incremental
evaluation](#incremental-evaluation) and [reactive programming
](#reactive-programming)

This works best when the code is written in a language with
[immutability](#immutability) and [pure functions](#pure-functions).


## Visual Presentation

A number of visual presentation techniques can greatly improve readability
of source code.  Many of them follow from embracing variable widths,
heights, and more flexible rendering, which are enabled by GUI environments.

- Render certain ASCII sequences as special glyphs:

   * `x -> 2*x` shown as `x → 2*x`
   * `<=`, `>=`, and `!=` as `≤`, `≥`, and `≠`.
   * `x_0` and `x_1` as `x₀` and `x₁`.

  Awareness of this tooling capability can inform language design.  For
  example, specifying operators as Unicode symbols is not necessary when the
  visual benefits can be achieved simply by rendering ASCII punctuation
  sequences in the desired manner.

- Display keywords and variable names in a variable-width font.  This
  directly enhances the readability of the names, and further improves
  readability by reducing the need for line breaking.

- Display large number literals with a [thin space](
  https://en.wikipedia.org/wiki/Thin_space) separating digit groups.  This
  yields the readability benefits of an explicit separator, like `_` in
  Rust, without embedding locale-specific representations in the source
  code.

- Automatically wrap long lines to the width of the window, breaking at at
  the lowest-precedence operators first.  This ensures readability across
  different window and font sizes, especially if code is viewed in different
  ways (e.g. pop-up windows) when using [interactive value
  exporation](#interactive-value-exploration).

- Allow rich text comments, with simple graphics.

- "Syntax" within strings: `\\`, `\t`, and `\n`, can be made more visually
  distinct, perhaps shown as boxed `n`, `t`, and `\` characters.

- Show the internal structure of string literals as determined by a parsing
  function they are later passed to (when that parser returns an object
  implementing a certain interface).

- Display tabular data (constructors of vector-of-vectors or
  vector-of-maps) as an actual table, with cell borders.


## Assertions

Assertions can appear anywhere in a program.  They identify a condition that
must be true when that line is evaluated.  If, when executed, the condition
is false, execution stops and an error is reported.  Assertions can help
reasoning about correctness of the subsequent code, either in terms of
correctness or in terms of meeting some looser requirements (e.g. types).

With [early evaluation](#early-evaluation), many assertion failures can be
detected statically, before a program processes its time-varying inputs.
Assertions about the type of a value are particularly amenable to static
detection, and can be particularly useful for optimization.  Rio's type
annotations can be thought of as a shorthand for type assertions.

By providing more and more such assertions, we can provide more and more
assurance about the correctness of our program.  However, this approach
differs from that of static typing with respect to the handling of
assertions that cannot be decided statically.  In a strongly-typed static
language, that would be a typing error, whereas in a dynamic language it
becomes a run-time assertion.  In order to allow the programmer to assert
soundness, a [hint](#hints) can specify an expression for which all
reachable asserts must be statically decided.  Type safety -- and other
assertions of correctness -- can thereby be gradually and modularly
implemented.


## Elevated Error Messages

Some assertions within a function might identify the caller as the offending
code (e.g. argument of wrong type was passed, or other constraints of the
contract were violated).


## Pure Functions

A pure function returns values that depend entirely on the values of its
parameters, and that has no observable side effects.  All Rio functions are
pure functions.


## Immutability

Immutability, herein, refers to the immutability of data values and variable
values in Rio.

There are a number of reasons to forbid mutation in a language.

Reasoning about programs with mutation quickly becomes unmanageable.
Far-flung pieces of code can interact in disastrous ways that are difficult
to predict.  Rust provides interesting facilities for managing many problems
associated with mutation, but in doing so it severely restricts the use of
mutation, and introduces significant complexity (such as the still largely
undocumented "borrow checker") to the language.

Guaranteed immutability of values simplifies many optimizations such as
[early evaluation](#early-evaluation).

Immutability allows us to implement [deterministic garbage
collection](#deterministic-garbage-collection).  Reference cycles in data
structures either (a) cannot occur (as in Rio), or (b) can occur but only
where the language can easily identify the cycles at time of construction.

Immutability of variables and data comes with some well-known downsides.
Some people see it as less intuitive and find things more difficult to
express in such a language than in languages with mutation, especially
loops.  Our answer to this is two-fold.  First, we provide ["imperative
syntax"](#imperative-syntax) features that support a more intuitive way of
thinking about iteration (without actually involving side effects).  Second,
while a different functional "mode" of thinking will be more
front-and-center in Rio, this mode is essentially that of identifying
invariants: asking "What can we say about the values at a given place in the
program?"  It is necessary to think in this mode in order to analyze your
code to prove it correct or develop confidence in it.


## Resource Lifetime Management

Back in the dark ages of computing, the legend goes, programmers explicitly
managed memory allocation.  They would call a function like `malloc` to
obtain the memory needed for a data structure, and they would call `free` to
return memory to the pool after it was no longer needed by the program.
Enter garbage collection (GC).  Initially considered a hack, it proved
workable and provided enormous benefits by freeing the programmer from the
need to manually manage the lifetimes of memory blocks.

Unfortunately, GC does not solve every lifetime management problem, so even
in languages with GC the programmer ends up writing code to clean up
resources.  In particular:

 - Unless the GC is [deterministic](#deterministic-garbage-collection), we
   cannot rely on it to discard objects that represent non-memory resources.

 - Objects that have registered for callbacks from long-lived objects will
   be considered "live" (reachable) by GC even when they are otherwise
   un-reachable by the program.

 - In a distributed environment, remote object invocation can be used to
   simplify communication between two software environments.  When GC
   operates on one of the environments, it can only deal with reference
   cycles that are fully contained in its own environment.  GC must treat
   all objects referenced from the other environment as reachable.  If we
   have a reference cycle that spans the communication boundary, GC will not
   be able to clean them up, even when both environments individually
   support GC.

The requirement for lifetime management is contagious.  We must call
destructors for not only primitive system resource objects, but any object
that owns a reference to such an object, and so on and so on.  Any data
structure that takes ownership of values, in order to be fully generic, must
participate in some lifetime management strategy for the things it contains.

Rio fixes this, through a combination of features:

 - [Deterministic garbage collection](#deterministic-garbage-collection).

 - [Reactive programming](#reactive-programming) avoids the need for
   reference cycles introduced by the [observer pattern](#observer-pattern).


## Deterministic Garbage Collection

Most garbage collection designs are non-deterministic with regard to *when*
the memory will be reclaimed.  We can often ignore this shortcoming, because
the event of running out of memory will itself trigger a GC cycle and
recover memory whenever it is needed.

However, objects that wrap external resources that are in limited supply --
for example, file handles -- present an additional problem.  With
*finalizers*, GC can ensure eventual cleanup of these resources, but,
without determinisitc finalization they may remain unreclaimed for an
arbitrarily long duration.  The program might exhaust the supply of these
resources long before it runs out of memory.

In those cases, we cannot rely on GC to perform the cleanup for us.
Instead, we have to write the same kind of code we would have written if we
had to manually manage memory: explicitly recovering the resource after we
were done using it, taking care to never do it too early.

Deterministic garbage collection gets us back to where we don't need to
worry about lifetime management in those cases.  In general, this is a
difficult problem, due to the potential of cyclic data structures, but
[immutability](#immutability) helps here.


## Lexical Scoping

With lexical scoping rules, the visibility of a variable can be easily
determined by looking at the structure of the source code; it does not
require analyzing the dynamic execution paths of the program.

Rio uses lexical scoping.  A variable's scope is the rest of its block.  The
"rest of its block" corresponds to all the subsequent consecutive lines of
code that are indented as much as or more than its assignment statement.

When two or more variable assignments use the same name, they define
different variables (that happen to have the same name).  Where their scopes
overlap the nearest (last) definition supersedes and is said to "shadow" the
earlier ones.


## Dynamic Dispatch

Functions or “methods” may be associated with a type, and may be retrieved
via a value of that type.

The name "dynamic dispatch" describes how an conceptual virtual machine
might interpret expressions, and it implies an implementation choice of
using run-time method lookup, but it does not prevent a compiler from
optimizing away a lookup when it can predict the type of the value.


## Duck Typing

Duck typing is a form of [dynamic typing](#dynamic-typing) in which the
behavior of a value is described entirely by the interface it exposes.  Rio
supports this through a consistent, thorough application of [dynamic
dispatch](#dynamic-dispatch).

Here is one illustrative example: `a + b` is defined as invoking the "+"
method of `a`, passing it `b`.  This contrasts with dynamic languages that
define "+" as a built-in function that has special cases for built-in types.

The main benefit of this approach is to maximize the power of user-defined
data types.  They are treated as first-class citizens.

Rio built-in types are special only in that they are used to construct
values from literal constants.  After construction, they have no special
privileges or capabilities.


## Inline Tests

Unit tests should appear alongside (immediately after) the function being
tested.  As the module is loaded (executed), the tests run, so the
validation occurs before consumers are exposed to the module.  Putting tests
inline allows non-exported functions to be tested, ensures and documents the
validation.

Inline tests can illustrate usage of the tested code.  In this way, they
nicely complement the [live programming](#live-programming) model.

Placing tests inline is sometimes avoided because of a run-time performance
penalty or an executable size overhead.  [Early
evaluation](#early-evaluation) avoids boths of those drawbacks.

In other languages, inline tests are conditionally compiled.  This involves
additional complexity in the language itself and in the build system.


## Standalone Sources

A property that scripting languages have, but some others do not: a program
can be expressed completely in the source code of that language, without the
need for other information (e.g. in build scripts, etc.) to define how to
construct the program and how it will actually work.

Example: Looking at a C program will not tell you how to compile or link it.
(1) Include directives may hint at dependencies, but do not necessarily
correlate with required object files or libraries.  (2) Even for facilities
included in the language standard, linking may require special arguments on
the command line (e.g. “-lm” if the program happens to link with a library
that uses floating point).  (3) Often linker “voodoo” is required.  (4)
Often special compilation arguments are required to select the appropriate
dialect.


## Abstraction Explosion

Multiple inter-related abstractions can interact to greatly increase the
difficulty of understanding.  This can work as an obstacle to learning the
abstraction.  When the abstractions have been learned, it can make working
with them more exhausting and more error-prone.

In a set of “floating abstractions”, we have a set of definitions that
reference each other and, presumably, afford a single consistent set of
meanings.  This is akin to a system of equations in linear algebra.  As long
as we have more independent equations than variables, we can solve it, but
the effort required in solving increases with the number of variables.


## Dynamic Typing

Dynamic languages present a simple mental model of execution, making them
relatively easy to learn and use.  One does not need to first learn a
complex type system to understand the fundamentals.  This is not just a
problem for novices, or the less educated or less intelligent.  The "[too
many languages](#too-many-languages)" problem means that anyone working in
software often find themselves needing to "dabble" in one language or
another.

Functions in a dynamic language are inherently polymorphic.  Without
polymorphism or "generics" we end up writing essentially the same function
again and again.  Statically typed languages require complex type systems
for even modest degrees of polymorphism.

Large projects in statically typed language often end up implementing their
own mechanisms that mimic a dynamic language (see Greenspun's Tenth Rule).
Instances where reflection is useful are good examples of this.  For
example, consider writing a function that will serialize *any* data
structure in your favorite statically typed language.

One drawback typically expected from dynamic typing is lower performance,
because without static typing we do not have type erasure, static method
lookups, and inlining.  However, we anticipate that [early
evaluation](#early-evaluation) can yield the same benefits in a dynamic
language.


## Gradual Typing

Gradual typing allows a program to be written with or without static type
declarations.  Adding type annotations to variables can help identify errors
statically, improve the maintainability of code, and enable performance
optimizations.

In the approach to gradual typing envisioned for Rio, type annotations will
not influence the behavior of a program, other than by restricting the types
of values that variables or expressions may take on.  To wit, if one were to
strip all of the type annotations from a program, the resulting program will
be as functional: it will behave equivalently for all inputs that the
annotated program handled without errors.

One can learn to use Rio, therefore, first by understanding its data types
and operations allowed on them.  The concepts of type values, type
expressions, and static typing may then be introduced to the programmer by
describing them as run-time assertions.  For example:

    sq = (x : Number) -> x * x

Is equivalent to:

    sq = x ->
        assert type(x) == Number
        n*n

With [early evaluation](#early-evaluation), the execution and failure of an
assertion can often be predicted before the code is evaluated.  For example,
even when the values of certain expressions are not known until run-time,
the types of those expressions may be known and run-time error may be
deduced in advance.  In these cases, Rio will report the error immediately
(e.g. at "compile time").

An exhaustive set of unit tests (integrated into the program) will help
ensure that run-time errors are either triggered by evaluation or predicted
at compile time.  However, run-time errors may remain unpredicted, and this
mode of analysis (typing as assertions) provides no guarantee of soundness.

We then introduce a means for a programmer to identify a function as
"sound".  This alters what the compiler will treat as an error, flipping the
burden of proof.  Instead of raising errors when it can prove that the
function will be called and encounter a type error at run-time, it will
raise errors it *cannot* prove that the function will *not* be encounter a
type error, *if* called.

This form of static analysis does not need to be limited to assertions about
the *types* of values.  Predicting failures of other kinds of assertion
failures (or proving them impossible) would be much more powerful than
simply checking types, and is an intriguing possibility to explore.

These gradual typing objectives influence language design in the following
ways (among others):

The language must adhere to a simple model of execution. Types are a
mechanism for making assertions about the program, not something that
dictates the meaning of the program.  We do not have overloading in the
sense of multiple alternative definitions of a variable bound at different
places.  We do not have "backwards-in-time" type inference, so when one
writes `x : BigNum = sum(vec)`, the type of `x` does not change the meaning
of `sum(vec)`; it just makes an assertion about its result.  (If we want to
a function to behave differently, we specify that in its inputs, as in `x =
sum(vec, BigNum)`.)

Methods and properties of the built-in data types should work well with the
type system.  They should enable the compiler to infer types easily, and
they should be easily describable in the type system, in order to minimize
the number of type declarations required to achieve soundness.

In order to increase opportunities for finding errors statically, and to
maximize the knowledge that can be propagated during [early
evaluation](#early-evaluation), Rio semantics will often be "tighter" than
those of other dynamic languages.  The arguments passed to a function must
agree with its formal parameter list.  Rio provides fewer [implicit type
conversions](#implicit-type-conversions).  Rio does not have a "null" value,
and treats accesses of undefined vector or map members as errors.


## Implicit Type Conversions

Most dynamic languages support a rich set of implicit conversions or
coercions.  While Rio generally has a dynamic "feel", it differs in this
respect.

* Implicit conversions require the programmer to know the conversion rules
  implemented by the languages and/or the data type involved.  This is an
  additional cognitive burden for programmers.

* Implicit conversions can make the intent of the author less clear.
  Without them, the programmer would have to be more explicit, which can
  help someone reading the code to see exactly what kind of conversion is
  anticipated, and can help the development environment automatically
  [detect errors statically](#early-evaluation).

Particularly problematic are the cases of implicit conversions of a
condition to a truth value, and implicit conversions performed when testing
equality.  Some dynamic languages, like Lisp & Lua, use very simple rules,
but others have rules that are so elaborate that most programmers who
regularly use the language would be unable to accurately describe them.
[JavaScript, perhaps the worst, even has rules for truthiness that are not
consistent with its own rules for equality.  Even when `x == y`, `if (x)
...` might not do the same thing as `if (y) ...`.]

The implicit numeric conversions in the C language are another example of a
set of rules so complex that working programmers will often be unable to
faithfully recount them.


## The REPL Problem

The value of interactive languages is the ability to try things and examine
outputs in order to remove uncertainty about the behavior of code.  As the
program grows, the code being explored requires a larger context (bindings
of names to values) than that of the default REPL environment.  One can
manually construct a environment in the REPL that matches the lexical
environment at a given point in a program, but the environment is different
at different places in the code.  Moving one's attention from one place to
another or modifying code changes the environment.  The effort required to
replicate a similar environment in the REPL gets out of hand as the program
grows.  Unfortunately, when things get complicated is when interactive
validation of assumptions would provide the most value.


## Interactive Value Exploration

IVE is an alternative to REPL-style interaction in a [live
programming](#live-programming) environment.

Using a REPL involves a sequential stream of commands and responses that
modify the interactive environment, resulting in [the REPL problem
](#the-REPL-problem).  In IVE, one can examine the results of any evaluation
at any place in the evaluation tree of the program.  This differs from
examining values in a conventional debugger because it does not require
capturing the program at a particular point of execution by setting
breakpoints or stepping chronologically forward.  Instead, the programmer
can browse down through the evaluation "tree" -- forward or backward in
execution order -- examining intermediate values.


## Order Annotations

Annotations can control when an expression is evaluated, selecting on-demand
or parallel execution.

By default, Rio uses [applicative order
](https://en.wikipedia.org/wiki/Evaluation_strategy).  Function arguments
are evaluated before the function is called, and an assignment's value is
evaluated before its body.  (In reality, early evaluation may change the
*actual* order of evaluation, but the observed behavior will remain
consistent with that of applicative order.)


### `defer EXPR`

On-demand evaluation can be specified using the `defer` unary prefix
operator.  For example:

    z = defer f(x/y)
    if y == 0: 0
    g(z)

Here, when `y` is 0, `f(x/y)` will not be evaluated.  When `y` is non-zero,
`g` will be called, and then, when (and if) the value of its first parameter
is needed, `f(x/y)` will be evaluated (at most once).

To be clear, `defer EXPR` does not specify a lazy evaluation *strategy* for
the sub-terms of `EXPR`.  In the above example, `x/y` will still be
evaluated (if at all) *before* `f` is called.  We could write `defer f(defer
x/y)` to have `x/y` evaluated on-demand during the call to `f`.


### `spawn EXPR`

The `spawn` operator is semantically equivalent to `defer`, but it acts as a
hint to speculatively begin evaluation of `EXPR` on another thread, in
parallel with the evaluation of the remainder of the program.  When and if
the value is used, the thread using the value may have to wait on completion
of the thread computing the value.  If an error has occurred during
computation of the value, the errors will be observed when an attempt is
made to use the resulting value.

As with `defer`, errors or infinite loops in the expression will not be
observed if the value is never used.


## Top Module == Build

There should be no need for a separate [build system](#build-systems) or
language.  If any artifacts are to be produced by the project -- e.g. a
command-line executable -- their construction would be described in the
language, in the "top" or "main" module file of the project.

To make this work well, we will want:

 * [Easy Parallelization](#order-annotations)
 * [Reactive programming](#reactive-programming)
 * APIs into the compiler


## Execution Contexts

Code executes with an Execution Context (EC).  Code can construct other ECs
in which other code can execute, and control the execution within that EC,
similarly to how a Lua VM embedded in a C program can be controlled by the C
program.  An EC has its own thread, and can execute in parallel, but it also
will ideally have resource constraints (CPU and memory), and can be
canceled when it does not terminate, so it is more like a UNIX "process",
although there should be a very low overhead for controlling an EC and
exchanging values with it.

The notion of an EC provides a model for dealing with potentially “ugly”
concerns in a way that does not sacrifice the purity of the language.

Debugging: The owner of an EC may be able to pause execution and examine its
internal state.  Exposing internals of the code to that code itself would
introduce side effects and other potential impurities that could affect
semantics in undefined ways.  The clear boundary between "inside" and
"outside" allows for well-defined semantics while providing an unlimited
degree of access to VM internals.

Exceptions: Although ugly, exceptions appear necessary for certain practical
reasons.  After all, we can’t have one memory allocation failure take down
our whole world.  We can, however, take an EC down, after partitioning our
world into ECs.  Therefore, instead of adding exceptions to a language --
which constitute another way for functions to return -- we should have fatal
errors *not* return, and simply halt execution (of the EC).  The caller of a
halting function has no way to catch this, but the owner of the EC can
observe the change of state of the EC from "running" to "halted".  Note that
this approach allows for graceful handling of infinite loops in a similar
manner.  After all, in most situations where we are concerned about recovery
from fatal errors we will also be concerned about code that doesn't
terminate in a reasonable amount of time, and code that consumes too much
memory.  An EC owner could enforce its own timeouts on the code running in
the EC, or simply allow the user to decide when to stop waiting.

A language that leaves these responsibilities to user libraries provides an
incomplete set of tools to the programmer.  To evaluate such a language we
must consider it together with some such library.  OS processes are
typically a very blunt instrument, and, without tight integration with the
language implementation, are unlikely to provide optimal performance.


## Exceptions

Exceptions provide another way for functions to return.  In Rio, functions
that assert or fault do *not* return, they halt.  This stops execution of
the EC.  The caller of a halting function has no way to "trap" or catch
this, but the owner of the EC may observe the change of its state from
"busy" to "halted".


## Zero-cost Abstractions

We can structure programs logically, using modules and function abstraction,
without worrying about the performance overheads.

Function inlining: We should be able to define functions and use them
without fear of function call overheads.  Without predictable inlining,
programmers often resort to manually expanding some functions inline.

Specialization: We should be able to write a single, generic implementation
of an algorithm instead of multiple hard-coded variants specialized for
different use cases.  The compiler should be able to specialize based on
constant parameters.


## Unique Values

In many dynamic languages we can create "unique" values -- vectors,
functions, etc. -- that can be differentiated from any other value
constructed in any other part of the program.  For example, in Lua: `local x
= {}` assigns a new table to `x`.  These can be useful as sentinel values
for recognizing data originating in this code.

If we execute this line of code again, we get another new table, different
from the one created the first time the code executed.  This breaks
beta-reduction and similar identities that enable code transformations and
analysis.

An alternative, preserving functional language properties, would be to have
a way to create a sentinel value tied to the location in the source file
where it initially appears.  Executing a function containing such a sentinel
constructor would yield the same value every time.

When we see:

    x = current_pos()

We treat it as sugar for:

    x = Sentinel(MODULE_PATH .. ":" .. LINE_NUMBER)


## Shadowing

Due to [immutability](#immutability), variables cannot be modified, but they
can be shadowed.  For example, in this code excerpt ...

    x = 1
    f = n -> n + x
    x := 2
    ...

... the line `x := 2` does not actually *modify* a variable.  It introduces
a *new* variable, also named `x`.  Only the new `x` will be visible to the
lines of code that follow.  The old `x` remains unchanged, so the behavior
of `f` is not affected by the definition that follows it.

As a shorthand for `x := x + EXPR`, we can write `x += EXPR`.  Similar
operators `-=`, `*=`, etc., are also defined.

Shadowing can be useful when a number of steps are used to construct a
single value.  It avoids the need to make up a number of arbitrary names for
the intermediate values.  This might happen more often in conjunction with
[update syntax](#update-syntax).

Shadowing is also important for [looping syntax](#looping-syntax).

Because un-intentional shadowing is a frequent source of bugs, the syntax
makes shadowing explicit.  Shadowing is disallowed when `=` is used.
Shadowing requires `:=`, `+=`, etc..


## Update Syntax

Due to [immutability](#immutability), we do not literally modify vectors or
structures, but we can construct new values that include the "modification"
we want.

The `set` method "replaces" a member of a vector or map.

    v = [1,2,3]
    v.set(1, 7)          # --> [1,7,3]

    m = {a:1, b:2, c:3}
    m.set("b", 5)        # --> {a:1, b:5, c:3}

The `setProp` method "replaces" a data property in a structure.

    s = UserStruct({a: 1, b: 2})
    s.setProp(b, 9)      # --> UserStruct({a: 1, b: 2})

Rio's update syntax allows such operations to be expressed easily,
by extending the notion of shadowing assignments.

    MEMBER_EXPR := EXPR

In this case, MEMBER_EXPR must consist of a variable name followed by one or
more property/item references, and *all* of them are "peeled" off and
converted to set operations.

Similarly, other update assignment operators can be used:  `+=`, `-=`, etc.

For example:

    x.c := 1        <==>  x := x.setProp("c", 1)

    x.c += 1        <==>  x := x.setProp("c", x.c + 1)

    x.a.b := 1      <==>  x := x.setProp("a", x.a.setProp("b", 1))

    x[2][5].b := 1  <==>  x := x.set(2, x[2].set(5, x[2][5].setProp("b", 1)))


## Looping Syntax

There are commonly encountered problems in programming that require
iteration, and the functional alternatives are not always the easiest way to
think about the solution.  Looping syntax provides a simple approach to
constructing loops, that uses shadowing rather than actual mutation of
variables.

Variables shadowed by assignments in a loop body will have their values
propagated to the next iteration of the loop, and when the loop exits, the
shadowed values will be propagated to the expression that follows the loop.
Within the loop body, the following are defined:

  * `repeat` skips the rest of the loop body, and proceeds directly to the top
    at the next iteration.
  * `break` transitions to the expression after the loop
  * `while COND` is equivalent to `if not COND: break`

Here is a simple example:

    sum = a ->
        n = 0
        total = 0
        loop while n < a.length:
            total += a[n]
            n += 1
        total

Similarly, iterating over a collection can be done with a `for` statement:

    for NAME in EXPR:
        BODY
    REST

For example:

    sum = a ->
        total = 0
        for x in a:
            total += x
        total


### Implementation Details

More precisely, looping syntax translates an expression of this general
form...

    loop:
        BODY
    AFTER

... to this purely functional equivalent:

    _post = (VARS...) -> AFTER
    _loop = (_loop, VARS...) -> loopx[BODY]
    _loop(_loop, VARS...)

... where `VARS...` is a sequence of variable names (those shadowed in the
body), and where `loopx[BODY]` appends a `repeat` line to BODY and performs
the following textual substitutions:

       break        -->   _post(VARS...)
       repeat       -->   _loop(_loop, VARS...)
       while COND   -->   if not COND: break;

Translating the above example, we get:

    sum = a ->
        n = 0
        total = 0
        _post = (n, total) -> total
        _loop = (_loop, n, total) ->
            if not (n < a.length):
                _post(n, total)
            total = total + a[n]
            n = n + 1
            _loop(_loop, n, total)
        _loop(_loop, n, total)


## Action Syntax

Rio provides a syntax for elegantly dealing with callbacks:

    PARAMS <- ACTION
    REST

The first line is a clause that designates the "rest" of the block as a
callback.  PARAMS is a parameter list, as it would appear in a function
definition.  ACTION is an expression that evaluates to a value that
implements an `and_then` property.  The rest of the block is packaged as a
function, accepting PARAMS, that is passed to the action object.  The above
code is syntactic sugar for something like the following:

    ACTION.and_then(PARAMS -> REST)

A chain of such clauses will result in a nested series of functions.  For example:

    x <- get("X")
    y <- get("Y")
    z <- get("Z")
    REST

... is equivalent to:

    get("X").and_then(x ->
        get("Y").and_then(y ->
            get("Z").and_then(z ->
                REST)))

This could be used to describe a chain of actions to be performed
asynchronously:

    connect = (auth) ->
        (hostname, port) <- parse_authority(auth)
        addr <- gethostbyname(hostname)
        s <- socket()
        () <- s.connect(addr, port)
        OK(s)

At each `<-` clause, execution of the "rest" of the block is at the
discretion of the action object.  This allows each action object to handle
failures by short-circuiting the rest of the chain.  This can be used as a
generic error-handling mechanism.  In the example above, we presume the
action objects short-circuit and return a Failure() value that itself is a
valid action object, so `connect` will be expected to return an action
object.  The last line uses an `OK()` constructor to wrap the successful
result in an action object.

This composes nicely with assignments, [update syntax](#update-syntax),
and [looping syntax](#looping-syntax), as in this example:

    fetch_list = list_url ->
        list_text <- do_http("GET", list_url, {})
        urls <- parse_lines(list_text)
        items = []
        for url in urls:
            data <- do_http("GET", url, {})
            items := items.push(data)
        items

An alternate syntax allows the programmer to specify how exceptional cases
are to be handled:

    PARAMS <- EXPR else: FAILURE
    REST

The above is syntactic sugar for:

    EXPR.and_then_else(PARAMS -> REST, () -> FAILURE)


For example:

    socket <- socket() else:
        Error("out of sockets")
    () <- socket.bind(INADDR_ANY) else:
        Error("failed to bind")
    () <- socket.listen(20) else:
        Error("failed to listen")


## Self-Hosting Phases

The first Rio implementation is a "bootstrap".  The focus is on simplicity,
not performance and feature richness.  It does not compile, and it does not
perform early evaluation.  The goal is to enable a Rio implementation
written in Rio as quickly as possible to reduce the time spent on non-Rio
code that will not automatically translate to all Rio-supported
environments.

The bootstrap interpreter is also called the Phase 1 or P1 implementation,
and the subset of the Rio language that it implements is also called P1.
The first Rio-based compiler will be P2: written *in* Rio P1, but
*implementing* Rio P2.

In order take advantage of a Rio feature that exists in P2, but not in P1,
then we will need to create a P3.  It can be tempting to use a new feature
that improves the code, and the additional validation it would provide is
desirable, but the additional phases add a bit of complexity to the project.
Indeed, for some time, it may be prudent to keep adding features to P1 for
the benefit of the P2 code.  Note that *phases* do not denote versions or
iterations, because P1 itself can change over time.  Instead a phase is just
a position in this chain of hosting, like phases of booting a computer.

Successive phases may be backwards compatible or not.  When a phase is
backwards compatible, then its compiler can be called "self-hosting": it can
compile itself, resulting in a compiler with the same functionality.  When a
phase is not backwards compatible, then some work will be required to
convert the previous compiler to the new dialect to create the next "Px".

Given multiple phases, each with its own compiler version, a complete
re-build from source would technically require running all the compilers,
starting with the bootstrap interpreter.  In practice, we would keep some
recently-generated binary as a "golden" compiler, and maintain work only on
the most recent phase.

I think it would be nice, however, to retain an unbroken "chain of custody"
from the bootstrap compiler, even when not regularly invoking those older
phases.  Perhaps this is partly driven by nostalgia, but also it can help
resolve issues when things go wrong.  By the way, Ken Thompson's Turing
Award lecture, "Reflections on Trusting Trust" is a great read, and touches
on some of the issues one might run into.


## Think-Do Gap

Programming is harder than it needs to be.

There is a certain amount of intellectual effort inherent in any programming
tasks, which is unavoidable.  This is the "think" part.

The task of producing working code -- the "do" part -- involves more than
just the "think" part.  We often have to say the same thing multiple times,
and solve the same problem again and again.  Even when solving the problem
once, the tools, libraries, and languages we use can make if harder than
necessary.

 - [Too Many Languages](#too-many-languages)
 - Needless Complexity
 - [Undefined Behavior](#undefined-behavior)
 - [Top-Level Code](#top-level-code)
 - Lack of [incremental evaluation](#incremental-evaluation).
 - Lack of [zero-cost abstractions](#zero-cost-abstractions).
 - Lack of reflection.
 - Lack of polymorphism or "generics".


## Too Many Languages

Many modern software projects require programmers to deal with many
programming languages.  Each of these languages typically has a woefully
large set of idiosyncrasies and outright design flaws for the programmer to
become knowledgeable in, or to unknowingly fall victim to.  The resulting
software development landscape is needlessly difficult to navigate.

Aside from the learning curve and ongoing cognitive burden, another problem
with splitting one problem across multiple languages and environments is the
difficulty of analyzing failures.  There is no complete stack trace to show
how or why the failing code was executed when the program was invoked by a
script that was used by a makefile rule that was invoked for a particular
configuration.  Data, after crossing the boundaries, can take on
unrecognizable forms.

Some of this differentiation is due to fundamental differences in languages
or their tooling.  One common dividing line is that between compiled
languages and interpreted.  Another is that between statically-typed and
dynamically-typed languages.  And there is the [high-level versus
low-level](#high-level-versus-low-level) gap.  Each side of these divides
has its pluses and minuses, making them more or less suitable to solving
different problems.  And some languages have their own unique tricks, or
killer features, such as languages designed for use in [build
systems](#build-systems).

Hopefully a language will be able to bridge these divides and provide the
best of both worlds.

But interestingly, much of the proliferation of languages is entirely
accidental.  How many of us have encountered projects using three or more of
{Python, Ruby, PHP, JavaScript}?  These languages differ mainly in
superficial details, and they are each saddled with their own unique set of
language design flaws and gotchas.  One does not add any *important*
concepts or capabilities lacking in the others.  This is on the one hand a
reason for optimism, since these kinds of language divides are easy to
avoid.  On the other hand, the fact that they have not been avoided is
perhaps a reason for pessimism.


## High-Level Versus Low-Level

A programming language should make programming (*correct* programming) as
easy as possible.  At the same time, it should be *possible* to write
performant code, because otherwise that leaves us with a need for *another*
language, perpetuating the tyranny of [too many
languages](#too-many-languages).

We feel that much of the performance benefits of low-level languages can be
addressed with a high-level language via [early evaluation
](#early-evaluation), [assertions](#assertions), [hints](#hints), [typed
structures](#typed-structures), and dynamic [profiling](#profiling).

In such a language, the programmer's task during optimization is one of
demonstrating to the compiler that certain shortcuts are legitimate, rather
than grabbing the controls from the compiler.  Some examples: Type
assertions can allow the compiler to predict method lookups and inline the
methods.  The compiler can employ mutation when it knows that the data
structure is not shared, and a programmer could maximize this by being aware
of the limitations of escape analysis, or even by including
(compiler-checked) assertions of uniqueness of references (a la Rust).

When compiling to a VM like Wasm, the compiler must deal with lower-level
concerns in some way.  These could be dealt with by a runtime library that
exposes only high-level functionality, but that would preclude a lot of
optimization possibilities.  The other way to deal with it would be to have
a low-level intermediate language that is aware of these issues.

Some of the lower-level concerns are:

 - Mutation and side effects
 - Memory allocation
 - Resource lifetimes
 - Memory layout


## Undefined Behavior

When behavior is not completely specified by the language, it creates
problems for programmers.  Unit tests may work one run, and fail the next.
Programs working for months may suddenly fail.  Instead, we should prefer
clearly specified behavior.  Stable sorts and deterministic enumeration of
map members are to be preferred.  (JavaScript's HashMap enumeration behavior
is a good example).

Under no circumstances is it acceptable to use the C language's "all bets
are off" definition of undefined behavior. When you cannot place any bounds
around the implications of an isolated programming mistake, you cannot come
to any meaningful conclusions when analyzing a large code base.

Another consequence of C's notion of undefined behavior is that the C
language is effectively unstable.  C programs that compile today might not
compile tomorrow.  The reason is that C is not inherently safe, but still
some unsafe usage can be identified by the compiler and reported as a
"warning".  In fact they go further and report warnings based on
circumstantial evidence when there may not be an actual bug.  The compiler
can never detect all unsafe usage, but it can get "better" at it over time,
so more warnings show up with newer compiler versions.  Due to the
catastrophic consequences of unsafety, any responsible developer treats
warnings as errors, so when new warnings show up they break the project.
The set of things forbidden by warnings constitute a de facto language
definition ... a language that is unspecified, constantly changing, and that
differs from compiler to compiler.


## Friendly Data Types

Rio provides the workhorse data types familiar to uses of modern dynamic
languages: booleans, strings, numbers, and functions, vectors (arrays), and
maps (aka hashmaps, dictionaries, associative arrays).  Aggregate values can
be constructed with declarative syntax: `[VALUE, ...]` and `{NAME: VALUE,
...}`.

Memory management is, of course, automatic.  Aggregates automatically "grow"
to accommodate new values [but actually, due to
[immutability](#immutability), what actually happens is new, larger values
are constructed.]

Vectors and maps can accommodate values of all types.  Instead of providing
a number of *alternative* types that differ in semantics and performance
characteristics -- e.g. untyped vector vs. typed tuple vs. homogeneous
vector -- these generic aggregates provide more uniform semantics while
allowing the programmer to add [hints](#hints) and
[assertions](#assertions), such as [typed structures](#typed-structures), to
select different performance characteristics or functional constraints.


## Typed Structures

Dynamic languages typically provide free-form data structuring mechanisms
that allow a variable number of fields, each of which can hold any type of
value.

However, dynamic languages are not incompatible with the notion of typed
structures and vectors, which facilitate efficient memory layouts.  The best
example of this is LuaJIT and its C FFI, which can actually be used to great
effect without ever calling into C.  Another example is JavaScript's typed
arrays.

Typed structures do not manifest as static declarations and typing
constraints on variables.  Instead, they are created at run-time, either by
first creating a [reified type](#reified-types) and then instantiating it,
or by directly creating an instance.  For example:

    a = Vector(I32)([1, 2, 3])

In the above example, a declarative heterogeneous vector expression is used
to initialize a homogeneous vector.  It is intended that [early
evaluation](#early-evaluation) will "optimize out" the construction of such
intermediate heterogeneous vectors.


## Reified Types

In a language with reified types, a type is a "first-class" value.

Reified types allow types to be constructed programmatically.  For example,
a combinator-based parser generator could construct not just parsing
functions, but the data types that hold the results.

This allows many of the benefits of meta-programming without the downsides
(mental gymnastics, workflow complications).


## Memoization

Memoization is important for [reactive programming](#reactive-programming),
to allow results at T(N+1) to reuse results calculated at T(N).

Since memoization seems to inherently involve stateful side effects, how do
we have it in a purely functional language?  We can address this by
considering the memoization cache as state managed by the [execution
context](#execution-contexts), which is essentially an instance of the
interpreter.  Those state changes are not observable by code running
*within* that EC, so that code sees no side effects and retains its
functional purity.  The EC itself explicitly deals with that state, not as a
side effect.

One challenge with using memoization broadly is placing bounds on the memory
usage.  If we accumulate prior results indefinitely, we run out of
resources.  We can associate the memoization cache with a [reactive
programming](#reactive-programming) graph node -- visible to the EC, not the
code it hosts.  Node "liveness" will control the lifetime of the memoization
cache.  Together with [deterministic garbage collection
](#deterministic-garbage-collection) this can ensure proper cleanup.  [This
works for results accumulated over multiple reactive evaluation cycles;
within any one evaluation cycles, all memoized results would accumulate, but
I don't think this is the problematic case.]


## Syntactic Resiliency

Ideally, the adverse impact of a mistake in one part of the code can be
contained, so the remainder of the code will be parsed as it would have been
without that mistake.  In many languages, a stray quotation mark, "{", or
"}", some missing syntax, or extraneous text can prevent most of the rest of
the file from being parsed.

Resiliency is particularly valuable in a live programming environment, such
as a worksheet view, so that a mistake on one line does not prevent viewing
of all values or errors below that line.  It is still of some value in
non-live contexts, so that a single compilation run can produce more
relevant error messages.

An editor could help with this to some degree, regardless of syntax.  For
example, when an open quote or paren is typed, the closing quote or paren
may be automatically supplied.  This is generally implemented as a
"suggestion" that the user can easily override.  However, going beyond
suggestion to restriction create a frustrating, straitjacket-like user
experience.


## 2D Syntax

When we look at a document, the 2D structure of it is immediately apparent
to us before we parse the sentence structure.  Indentation is a familiar
and natural way for people to write documents that have a hierarchical
structure to them such as outlines, tables of contents, or programs.

In most programming languages, although programmers universally apply
indentation to indicate the hierarchical structure of their code, it is not
syntactically significant.  Instead, delimiters (either punctuation or
keywords) are used to delimit sub-blocks.  We have, therefore, two different
ways of describing the structure, and we strive to keep them in sync and
even create tooling for this purpose.

Assuming we have a properly indented program, what value do the delimiters
provide?  They add redundancy, but from a [syntactic
resiliency](#syntactic-resiliency) point of view, indentation has enough
redundancy on its own, and when it disagrees with delimiters, we would
prefer to follow the indentation.  This is because an omitted delimiter or
an extra one has far-flung consequences.  The indentation of each line is
like a signpost that allows the parser to synchronize itself with the
syntactic structure after an error.  The signpost indicates whether some
syntax was missing or some extraneous text was encountered.

That leaves us with the downsides of delimiters: extra syntax for the user
to maintain (in addition to indentation), and visual clutter.  Delimiters
are clutter because the user already has seen the 2D structure before their
brain gets around to locating and matching up keywords or symbols like
braces.


### Continuation Lines

The above discussion sidesteps one fly in the ointment.  That is the
confounding issue of distinguishing nested blocks from "continuation" lines.

        a = b + (c + d
            + e) * f
        x = f(a,
              b)

While a continuation line is "part" of an expression, it does not
necessarily correspond with an individual sub-expression.  It may consist of
the end of one sub-expression and the start of another.  This means that the
2D structure that is immediately apparent to us may not actually conform to
the actual hierarchical structure of the program.  In these cases, we need
to look at the text, not just its indentation.

In Rio, the solution is to examine the content of the line or lines that
begin a new indentation level.  Test that introduces a multi-line block --
assignments, `if` statements, etc. -- can easily be distinguished from other
lines.  Such lines begin a new block, and other such lines are treated as
continuation lines.


## Early Evaluation of Constructors

An implication of [early evaluation](#early-evaluation) that is fairly
straightforward but still worth calling attention to is that we can rely on
constructors to be evaluated early when they are invoked on literals.

This reduces the pressure to complicate the language with grammar for
literals of various types.  For example, regular expressions can be
constructed from a string:

    regex = RE("a(.*)b+")

This is just as good as a regex literal from a performance perspective.
Also, any mal-formedness *within* the string will be detected by the `RE`
constructor statically (in the live environment, *immediately*, as it is
typed).

Types derived from [`String`](#strings) can also benefit, without being
hard-coded into the language with their own syntax (as in Python).

    text = Utf8("abcdef")
    text = Bin("abcdef")

Perhaps the most important implication of CTE for constructors is the
construction of complex types involving typed data structures.  For example:

    V32 = TypedVector(Uint32)
    v = V32([1, 2, 3])

Here, an untyped vector (a vector of `Any`) is being constructed and then
passed to the `V32` constructor, which then packs the values into a typed
vector.  This is performed exactly once, even if the line of code in which
it appears is "evaluated" multiple times (according to the canonical order
of evaluation).  At run-time this manifests only as a constant vector of
32-bit values.

Rio does not need to summon "backwards-in-time" type inference in order to
achieve this.  Dynamic typing provides a simple mental mental model for
understanding the result.

Going a bit further, consider the following example:

    a = V32([x, y, z])

Even when the values of `x`, `y`, and `z` are not known statically, the
size of the vector is known and the actual existence of the intermediate
untyped vector is unnecessary.

One option that may be explored is using an arbitrary precision numeric data
type for numeric literals, in which ordinary operations (`+`, `-`, `==`,
...) on the value will first convert it to float64.  This would ensure that
early evaluation can easily reduce the values to float64 and avoid complex
representations and heap allocation at run-time, yet preserve the original
meaning of the literal when it is passed to a constructor for an alternate
numeric type.

    n = Bignum(123456789012345678901234567890)
    d = Decimal(1.23)

Such a constructor would extract information from the number using a special
interface provided for bypassing coercion to float64.


## Primitive Types


### Number

The `Number` data type, used for numeric literals, is 64-bit IEEE-754
floating point.

Downsides of this choice include:

 * `0.1 * 10 != 1`
 * `(x + 1) - 1 != x` for values of |x| >= 2^53
 * `(x * 3) / 3 != x` for some values of x
 * `0 == -0`, but doesn't always behave the same
 * `NaN != NaN`
 * `Inf` and `-Inf`

The problem with decimal fractions is insidious.  Numbers immediately take
on a value that is not equal to what was written.  This data type is not
well suited to dealing with numbers produced by humans.  The language could
detect literals that cannot be represented exactly (e.g. too large, too
precise, etc.) and treat them as errors, but that would absolutely forbid
literals like `0.1`.

The inability to represent all 64-bit integer values appears to be a problem
that presents itself primarily when interacting with C or other low-level
languages in which programmers have tailored interfaces to the 64-bit
integer types.  Otherwise, it would be quite rare to encounter situations in
which one needs a value to hold integers bigger than 2^53 but not bigger
than 2^64.

Perhaps ideally, we could have arbitrary-precision decimal numbers, with all
operations preserving precision, except for division, which would return
floating point.  Abstract interpretation could (hopefully) tell the compiler
when integers could be used to represent the values, such as in a loop
counter.  Of course, some `Float64` type would still have to be available in
the language for type structures and vectors.

However, floating point is overwhelmingly the practical choice.

 * Modern hardware supports it well, so we get good performance right out of
   the gate without exotic optimizations.

 * Other dynamic languages use it as their numeric data type, so we can
   leverage specification work done by, e.g., ECMAScript.

 * It works just fine for almost all integer use cases.

 * Having a single built-in numeric type keeps the language definition
   simple.

One alternative that would be clearly *better* is Douglas Crockford's
[`DEC64`](https://www.crockford.com/dec64.html) proposal.  Something to
keep in mind.

Some other options under consideration:

 * Hexadecimal literals.  Numbers must still begin with a digit, but may
   contain A-F when followed by the suffix `_16` (visually rendered as a
   trailing "16" subscript).

 * Precise literals, converted to `Float64` when used.  This will allow
   high-precision number types to leverage [early evaluation of
   constructors](#early-evaluation-of-constructors).


### Strings

Strings are typed vectors of 8-bit unsigned integers.

A *typed vector of T* (`[T]`) behaves mostly like an ordinary untyped
vector, but it differs in that its "mutation-like" operations will only
accept values of type T.

Strings have presentation behavior that is biased toward UTF-8 text.  In
other words, they implement an interface that is used by the IDE to format
values for display to the user, and that format, while it can represent any
possible string, works best for readable text encoded in UTF-8.

One may define types that derive from `String` and apply different
presentation bias (e.g. hex display for binary data).

One may derive a type that ensures the contents are well-formed UTF-8,
allowing for optimization of some UTF-8-specific operations.  Perhaps this
will be built into the language.

Note that derived string types benefit from [early evaluation of
constructors](#early-evaluation-of-constructors).
