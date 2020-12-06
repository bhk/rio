# Rio Concept Map

This is a non-linear document, not necessarily read from top-to-bottom.
Each section has hyperlinks to other sections that provide necessary
background.

----

## Rio Internals

The language design can be summarized by the following list of ingredients,
which loosely follows the thought processes that lead to the current design.

 * [Core Language](#core-language)
 * [Methods And Properties](#methods-and-properties)
 * [Imperative Syntax](#imperative-syntax)
 * [Partial Evaluation](#partial-evaluation)
 * [Typed Structures](#typed-structures)
 * [Reactive Programming](#reactive-programming)
 * [Order Annotations](#order-annotations)
 * Pattern Matching & Destructuring
 * [Gradual Typing](#gradual-typing)


## Core Language

The core language (CL) is a minimal, pure functional language, similar to
the lambda calculus with a strict evaluation strategy.  All Rio programs are
translated to this internal representation before being evaluated.

Evaluation of a CL expression takes place within the context of a "lexical
environment", which maps names to values.  As currently formulated, the CL
has five types of expressions:

 * Function construction.  Like `lambda` in Lisp, a function construction
   expression evaluates to a function value.  It consists of a snapshot of
   the current lexical environment, a list of parameter names, and a
   function "body" sub-expression.

 * Function application.  This type of expression includes a sub-expression
   for the function and a list of sub-expressions for arguments.  The
   function and its arguments are first evaluated, and then the function is
   "called" with the resulting argument values.

   There are two kinds of function values: CL and native functions.  CL
   functions are those created by function definition expressions.  Native
   functions are implemented by the runtime environment.

 * Parameter references.  This expression includes a parameter name, and
   evaluates to the value associated with the parameter in the current
   environment.

 * Constants.  A constant expression evaluates to a specific Rio value.

 * Branch.  A branch has three sub-expressions, a condition, a "then"
   expression, and an "else" expression.  When a branch is evaluated, the
   condition is first evaluated. If the result is `true`, the "then" expression
   is evaluated and returned.  Otherwise, the "else" expression is evaluated
   and returned.

Variable bindings and data structures are [immutable](#immutability).

Variable visibility adheres strictly to lexical scoping.  There are no
global or dynamic variables.

The CL is dynamically typed.  Parameters may take on any value.  In fact,
the CL has no knowledge even of dynamic types, except for functions and
booleans.  Other values can be differentiated only by their behavior, and
their behavior is only observable via native functions.

Other features in the Rio language build upon this CL foundation in the
following ways:

 1. Transforming Rio syntax to the internal CL structure ("de-sugaring").
 2. Defining native functions that construct and operate on values.
 3. Supplying bindings for the intial lexical environment (the environment
    within which each Rio module is evaluated).


## Imperative Syntax

A number of features that resemble imperative programming, but without the
pitfalls of mutable data, are implemented as syntactic sugar.

 * [Update Syntax](#update-syntax)
 * [Looping Syntax](#looping-syntax)
 * [Action Syntax](#action-syntax)


## Syntax Introduction

Here is a quick summary of Rio's "inline" syntax:

 - Numeric and string constants:  `1`, `1.0e4`, `"hello"`
 - Variables: `x`, `foo_bar`, `FooBar`
 - Infix expressions:  `a + b * c`
 - Prefix operations:  `not a`,  `-x`
 - Function construction: `(x) => x * 2`
 - Function application: `f(x, y)`
 - Array construction: `[x, y, z]`
 - Array de-reference: `a[1]`
 - Record construction: `{a: 1, b: 2, c: 3}`
 - Property de-reference: `r.prop`

Separate from inline syntax is "block-level" syntax, as specified by a [2D
(indentation-based) syntax](#2d-syntax).  This includes:

 - Assignment expressions
 - Conditional expressions
 - Imperative expressions

For example:

    f = (a, b) =>
        x = a + b
        if x < 1: 0
        loop while x < 10:
            total += x
            x += 1
            repeat
        total

See [vertical syntax](#vertical-syntax) for more on block-level constructs.
Refer to `syntax.md` and `syntax.lua` for the complete definition.

There is no syntax for Boolean constants, but the variables `true` and
`false` are primordial variables, implicitly part of the lexical environment
of each Rio module.


## Vertical Syntax

Rio syntax supports a "vertical" program structure, so that code reads down
the page instead of diagonally down and to the right insome other functional
langauges.  Likewise, data flow (during execution) generally progesses down
the page, which can help in visualizing and understanding the code, as well
as authoring in a worksheet-based [live programming](#live-programming)
environment.

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


## Methods and Properties

Values may have properties and methods.

The `.` operator is used to obtain properties.  For example, `value.name`
evaluates to the `name` property of `value.`

A "method" is nothing more than a property that evaluates to a function.  A
method will typically be able to access the value from which it was obtained
(its `self` value) as a captured value, so there is no need to pass a value
to one of its own methods, as in some "OO" languages.  The expression
`a.foo()` is equivalent to `tmp = a.foo; tmp()`, exactly as logic would
dictate (but unlike some other languages).

Also, Rio does not confuse properties with members of collections.  Indexing
expressions -- e.g. `value[index]` -- access members of an array or
dictionary, not their properties.

`a.?foo` evaluates to `true` if `a` has a `foo` property.

Internally, a Rio primitive function `get_property(value, name)` is used to
obtain properties.  `a.foo` is shorthand for `get_property(a, "foo")`.
Breaking this down to more primitive operations, `get_property` obtains the
type of the value, and from that obtains the type's own `get_property`
method, and then calls it.

     get_property = (value, name) =>
        type = type_of(value)
        gp = get_get_property(type)
        gp(value, name)

Rio's infix operators are defined in terms of properties.

    x + y    <==>   get_property(x, "+")(y)

Member access is done via the "[]" property:

    a[k]     <==>   get_property(a, "[]")(k)

Properties express essentially all of the behavior of a value, except for
function invocation.

Abstract data types are constructed by providing an implementation of
`get_property` for that type.

    gp = (self, name) => ...
    new_type = derive(old_type, gp)

TBD: defining structures and constructors.


## "Compile-time"

Compilation is an overloaded term, referring to a number of separate issues
that go together in traditional languages, but not necessarily in Rio:
static analysis, code generation, and construction of an "object" file.

Compilation usually involves some amount of static analysis.  Let us call
this static analysis, and not "compile-time" analysis, and define it as the
analysis that is done by examining the program alone, without any knowledge
of inputs to the program.

Compilation and code generation are often thought of as synonymous -- and in
fact code generation is typically the biggest part of a "compiler".  In Rio,
code generation can happen after a deplorable image is generated, and after
user input has been consumed, similarly to how a JIT-based VM works.

Originally, compiling meant producing an object file: a deployable
executable image.  In a Rio *worksheet*, the user sees the results
immediately as the program is modified.  There is no executable image to
see, or even to ascribe any meaning to.  Rio can generate deployable
executables, but that step should be seen as just "deployment", and not as
the trigger for code generation or static analysis.

This goes beyond implementation choice; the language definition does not
depend on a notion of "compile-time".  Rio does not distinguish [top-level
code](#top-level-code), and its provides no "compile-time" primitives, like
`#ifdef` instead of `if`, since values that never change (e.g. size of a
number) will be erased during [partial evaluation](#partial-evaluation).


## Top-Level Code

Some languages distinguish "top-level" code from code that occurs within a
function body.  This complicates the mental model of the language.  In
languages without this distinction, top-level code is nothing special; it's
the same kind of code as a function body.

For example, in C or Rust, the expressions that are valid in top-level --
e.g. on the RHS of a global variable definition -- are a subset of the
expressions valid within a function.  This means that when complex
initialization is required, it must be done (using mutation) at "run-time",
introducing the problem of ensuring the initialization is done before the
variable is referenced.  Also, there is a different set of visibility rules
for functions and variables defined at the top level than for variables
defined within a function body.  In Rust, this means that the programmer
cannot rely on type inference for globals, and must explicitly declare
types.

In Lua, JS, and Python, top-level code is function body code.  Compilation
is just an optimization that does not complicate the language.

The motivations for assigning a different meaning to top-level code stem
from the model for compilation and linking used by those language
implementations, and from performance concerns.  These motivations disappear
when [partial evaluation](#partial-evaluation) is supported.  The modules
can be discovered, loaded, and evaluated at "compile-time".  Module return
values, such as exported functions, are typically constant, allowing their
returned functions to be directly linked with call sites, or even inlined.
[Note that "bundle-time" or "deploy-time" is perhaps a better term in this
case, since compilation of code, such as user-supplied code, at "run-time"
is not absolutely forbidden.]


## Reactive Programming

Reactive programming languages allow us to deal with time-changing values
implicitly, rather than explicitly.

In a conventional procedural programming language, changes are indicated
with callbacks, typically using the observer pattern.  When one object
constructs its state (for example, a UI view) using data obtains from a
second object (for example, a time source), it will register for
notification of changes from the second object, and on receiving that
notification it will re-calculate as necessary.

In a reactive language, one would simply express the UI view as a function
of the time source.  As the time source changed, so would the UI view.
There is no need to write code for registering for notifications, or the
registration function itself, or notification of observers.  Nor is there any
need for all the de-registration aspects that come along with those
registration mechanism.

Aside from drastically reducing the amount of code required, this paradigm
simplifies designs by factoring out the notion of whether a value changes
over time.  In an OO listener-based approach, values that are allowed to
change over time are special, and the mechanisms to support it present
numerous small design decisions that can lead to many superficial
differences (pull vs. push, whether notifications are delivered as deltas,
etc.)

For efficient reactive programming, [incremental
evaluation](#incremental-evaluation) should be pursued.

Reactive approaches and [incremental evaluation](#incremental-evaluation)
are easier to add to a language with [immutability](#immutability).


## Incremental Evaluation

Once a programmer has written a function, the language can not only compute
its result when given its inputs, it can also efficiently recompute a new
result given slightly different results.  This avoids the need for the
programmer to manually write incremental variants of functions.

This idea does not require a magical, universal solution that applies to
arbitrarily complicated algorithms.  In order to be useful and relevant, it
only needs to be reasonably effective for the kinds of functions we most
commonly encounter in programming (searching, filtering, transformation,
etc.).  Even when some programmer involvement is required -- e.g. via
annotations that influence the granularity of recalculation -- it could
still reduce the amount of programming work dramatically.


## Compile-Time Evaluation

"Compile-time execution" is a commonly used term for executing parts of a
program during compilation, rather than at run-time.  Given Rio's
[compile-time](#compile-time) flexibility, this definition is inadequate,
and the concept reduces essentially to [partial
evaluation](#partial-evaluation) of code before code generation, which in
turn can be triggered by evaluation of a recursive function (e.g. a loop
body) or construction of an executable.

This affords affording many [zero-cost abstractions
](#zero-cost-abstractions), and in many cases reduces dynamic language
overheads, eliminating method lookups, "erasing" type information, inlining
functions.  It effectively turns [inline tests](#inline-tests) into
compile-time tests.


## Partial Evaluation

Partial evaluation is [specialization](#specialization) of functions for the
context in which where they are called.  For example, when we know the value
of a parameter being passed by the caller, or if we know the type of the
value, we can eliminate assertions, propagate constants (e.g. method
lookups), etc., to yield a faster function.

In partial evaluation, we propagate knowledge we have about the function's
inputs and free variables, evaluating and simplifying sub-expressions where
possible.  There are different kinds of knowledge we may have about a value:

  - We may know the precise value.

  - We may know its type.

  - We may know that the value is a composite (array or record), and have
    further knowledge about some of its members.

  - Over time, there are more granular forms of knowledge that we may
    introduce.  One general area for exploration is predicates on built-in
    types, such as `0 < value < 10`, or `is_valid_utf8(value)`.

Some well-known optimizations can be considered specializations:

 * Constant propagation specializes for specific values.

 * JIT tracing specializes control flow, according to how types and values
   influence branches.

Note that [immutability](#immutability) and [pure
functions](#pure-functions) in Rio maximize the potential for partial
evaluation.  Most modules (those structured as reusable libraries) will not
have any inputs that change at run-time, so partial evaluation can produce a
precise value for every library, and precise values for all the members of
those libraries.  Functions imported from libraries are always available for
inlining and specialization.


## Specialization

A generic function can be compiled to one or more non-generic object
instances that assume the types or values of one or more parameters.

Validation of the assumptions must be done before executing the specialized
object code.  When the specialization was triggered by [partial
evaluation](#partial-evaluation), we know the context is one in which the
assumptions are valid.  Alternatively, we might generate multiple
specialized forms of a function (as directed by programmer [hints](#hints)
or [profiling](#profiling)) and select the appropriate one at run-time.
Finally, specialization could be performed at run-time, like a JIT compiler,
triggered by, perhaps, a previously unseen type for a paramter.


## Partial Eval Algorithm Notes

[The terms "Symbolic Execution" or "Abstract Interpretation" sound
appropriate, but each of those terms refers to a body of literature
describing a specific set of techniques, and I am not familiar enough with
them to say which term (if either) describes what I have in mind.]

In the case of assignment expressions -- `V = EXPR1; EXPR2` -- we first
statically evaluate EXPR1 to obtain knowledge of V, and then statically
evaluate EXPR2 with that knowledge of V.

Conditional expressions can be short-circuited when the condition can be
statically evaluated.  When they cannot be short-circuited, knowledge of the
resulting value is given by the *intersection* of the knowledge of both
branches.  The condition can provide additional knowledge of values within a
branch.  For example, in the expression `if x == 7: x*x; 2`, the
sub-expression `x*x` statically evaluates to `49` because the condition
gives us knowledge of `x` in that branch.  Since both `49` and `2` are
numbers, the result of the `if` expression is known to be a number.

Function values: In the assignment `f = (x) => x + 1`, we have a precise
value for `f` (a function).

Function invocations: When statically evaluating a function call, if we know
the precise value of the function, then we can statically evaluate the body
of that function using what knowledge we have of the parameters.  For
example, given the above definition of `f`, the expression `f(2)`,
statically evaluates to `3`.

Recursion limits abstract evaluation.  If we do not have precise knowledge
of all parameters, then we cannot determine when the recursion will
terminate.  In such cases, partial evaluation results in imprecise knowledge.
Abstract evaluation does not "loop", and the time spent in abstract
evaluation of a program -- much more heavyweight than ordinary evaluation --
is limited to O(N) where N is the number of expressions.

If, however, we have static knowledge of precise values for all parameters
of the recursive function, we generate optimized (non-abstract) code for it
and evaluate it, yielding a specific value for the result (statically).
Although this employs essentially "dynamic" evaluation, since all inputs can
be determined purely form the program source, the result can as well.

Code generation (for dynamic evaluation) can take advantage of any static
knowledge of values.  This enables inlining of functions, type erasure,
eliminating of unreachable code, and skipping method lookup and even double
dispatch steps.



## Hints

Hints are statements in the code that do not affect the results of the
program, but may affect optimizations.

For example, a hint may suggest specializing code for values within a
numeric range.  E.g.  0 <= n <= 2^32.


## Profiling

Observing execution of code to collect information that can be fed back into
compilation to direct optimizations.  This can indicate when a particular
[specialization](#specialization) is worthwhile.


## Build System

Build systems enable [incremental evaluation](#incremental-evaluation) and/or
[parallel](#order-annotations) evaluation, working with files as values.
Typically this is accomplished by explicitly naming dependencies separately
from the command that consumes them.  Similar problems (not necessarily
involving “files” and “commands”) occur in many places in software
development.


## Shell Programming

Interactive, but not [live programming](#live-programming).  Instead, try and re-try, and
manually repeat sequences of statements.

Once a script is complete, one might rewrite it using a [build
system](#build-system), in order to enable more efficient updates in
response to changes in inputs.  Or, the scripting language and engine could
be enhanced to support [incremental evaluation](#incremental-evaluation).
At that point, the script *is* a build script, although the parallel
evaluation features of the scripting language may be lacking.  (Parallelism
is manually managed in shells, but inferred from the dependency tree in
make.)


## UI Development

Updating parts of the display as system state change typically involves
writing listener-related code: register for notifications, handle
notifications, de-register, handle registrations and deregistrations,
deliver notifications.

This is made easier by [incremental evaluation](#incremental-evaluation).

This benefits from [live programming](#live-programming).


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
heights, and more flexible rendering that are enabled by GUI environments.

- Render certain ASCII sequences as special glyphs:

   * `x => 2*x` shown as `x → 2*x`
   * `<=`, `>=`, and `!=` as `≤`, `≥`, and `≠`.
   * `x_0` and `x_1` as `x₀` and `x₁`.

  Awareness of this tooling capability can inform language design.  For
  example, specifying operators as Unicode symbols is not necessary when the
  visual benefits can be achieved simply by rendering ASCII punctuation
  sequences in the desired manner.

- Display keywords and variable names in a variable-width font.  This
  directly enhances the readability of the names, and further improves
  readability by reducing the need for line breaking.

- Automatically wrap long lines to the width of the window, breaking at at
  the lowest-precedence operators first.  This ensures readability across
  different window and font sizes, especially if code is viewed in different
  ways (e.g. pop-up windows) when using [interactive value
  exporation](#interactive-value-exploration).

- Allow rich text comments, with simple graphics.

- "Syntax" within strings: `\\`, `\t`, and `\n`, can be made nore visually
  distinct, perhaps shown as boxed `n`, `t`, and `\` characters.

- Show internal structure of string literals as determined by a parsing
  function they are later passed to.  (When that parser returns an object
  implementing a certain interface).

- Display tablular data (constructors of vector-of-vectors or
  vector-of-records) as an actual table, with cell borders.


## Assertions

Assertions can appear anywhere.  They assert a condition that will be
checked when that code is executed.  If the condition fails, an error is
generated, preventing execution of the code that follows the assertion.

Assertions can help reasoning about correctness of subsequent code, either
in terms of correctness or in terms of meeting some looser (e.g. type)
requirements.  This can allow an incremental/modular approach to
verification of a program.

Assertions can also enable optimizations of the subsequent code.

Assertions of type enable optimizations similar to that of static typing,
except where reachability is in question.  Perhaps the language could take
an aggressive stance on assertion violation, wherein it will error at
compile-time unless it can convince itself that the program will not trigger
the assertion.

With abstract evaluation, assertions approach formal validation.

With [compile-time evaluation](#compile-time-evaluation), assertions can
generate compile-time errors. detected at compile time. and partial
evaluation, and compile-time detection of assertion failures, elevated
assertions look like type errors in a static language.


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
[partial evaluation](#partial-evaluation).

Immutability allows us to implement [deterministic garbage
collection](#deterministic-garbage-collection).  Reference cycles in data
structures either (a) cannot occur (as in Rio), or (b) can occur but only
where the language can easily identify the cycles at time of construction.

Immutability of variables and data comes with some well-known downsides.
Some people see it as less intuitive and find things more difficult to
express in such a language than in languages with mutation, especially
loops.  Our answer to this is two-fold.  First, [looping syntax
](#looping-syntax) supports a more intuitive way of thinking about
iteration.  Second, while a different "mode" of thinking will be more
front-and-center in Rio, this mode is essentially that of identifying
invariants: asking "What can we say about the values at a given place in the
program?"  It is necessary to think in this mode in order to analyze your
code to prove it correct or develop confidence in it.


## Deterministic Garbage Collection

Garbage collection allows us to ignore the problem of recovering unused
memory in our programs.  Our programs create new values, consuming memory
and perhaps other system resources, and those resources are automatically
recovered when those values are no needed by the program.

Most languages use garbage collection mechanisms that are non-deterministic
with regard to *when* the resources will be recovered.  We can often ignore
this shortcoming, because the event of running out of memory will itself
trigger a GC cycle and recover memory just-in-time.  However, when dealing
with values that hold non-memory resources, such as file or socket
descriptors, we simply rely on GC to perform the cleanup for us.  Instead,
we have to write the same kind of code we would have written if we had to
manually manage memory: explicitly recovering the resource after we ware
done using it, taking care to never do it too early.

This lifetime management complexity is infectious.  Not only do the
primitive system resource objects have "destructors" that must be called,
but any object that owns a reference to such an object will in turn have a
"destructor" that needs to be called, and so on and so on.  If any such
object needs to be shared by two other objects, reference counts probably
come into play, giving the programmer yet more code to write.  Any data
structure that takes ownership of values, in order to be fully generic, must
participate in some lifetime management strategy for the things it contains.

Deterministic garbage collection gets us back to where we don't need to
worry about lifetime management.  In general, this is a difficult problem,
due to the potential of cyclic data structures, but [immutability
](#immutability) helps here.


## Lexical Scoping

In lexical scoping, the visibility of a variable is exident from the source
of the program, and does not require anylyzing the dynamic execution paths
of the program.

In Rio, there is no other type of scoping.  A variable's scope is the rest
of its block.  The "rest of its block" corresponds to all the subsequent
consecutive lines of code that are indented as much as the assignment or
more.

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

With duck typing, the behavior of a value is described entirely by the
interface it exposes.  Rio supports this by defining its built-in operators
using [dynamic dispatch](#dynamic-dispatch).

Here is one illustrative example: `a + b` is defined as invoking the "+"
method of `a`, passing it `b`.  This contrasts with languages that define
"+" as a built-in function that has special cases for built-in types.

Rio built-in types are special only with respect to literal constants and
array and map constructors.  After construction, they have no special
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
penalty or an executable size overhead.  [Partial
evaluation](#partial-evaluation) avoids boths of those drawbacks.

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

We start with dynamic typing because it is easy to implement.  We like the
assurances provided by static type checking, and look forward to introducing
gradual typing in the future, and even beyond that, automated proof
checking.  However, we first want to experiment with language design issues
that are more fundamental, after which we can evaluate different approaches
to static typing.  We anticipate an approach that views [type annotations
as assertions](#type-annotations-as-assertions).

Aside from type checking, statically typed languages usually offer
performance benefits, because they allow type erasure, static method lookup,
and better inlining.  However, we anticipate that [compile-time
evaluation](#compile-time-evaluation) can yield the same benefits in a
dynamic language.

Dynamic language present a simple mental model of execution, making the
language easier to learn and use.  One must learn the types of values the
language supports, and the operations it allows.  One does not need to first
learn a complex type system to understand the language constructs, because
the type annotations will not change what the code does, they will only make
assertions about values.  This is not just a problem for dabblers, novices,
or the less educated or less intelligent.  The "[too many
languages](#too-many-languages)" problem means that even experts working in
software often find themselves dabbling in some language.  Every language
should pull its own weight, and some languages are too heavyweight.

Languages that support dynamic typing are more powerful.  Functions in a
dynamic language are inherently polymorphic.  Without polymorphism or
"generics" we end up writing essentially the same function again and
again. Statically typed languages require complex type systems for even
modest degrees of polymorphism.

Large projects in statically typed language often end up implementing their
own mechanisms that mimic a dynamic language (see Greenspun's Tenth Rule).
Instances where reflection is useful are good examples of this.  For
example, consider writing a function that will serialize *any* value in your
favorite statically typed language.

Some even resort to meta-programming, which I see as an unfortunate result of
a language's rigidity in its data typing and its notion of [compile-time](#compile-time).
These are related concepts, since the whole notion of static typing is that
a certain class of errors must be found at "compile-time", which is an
arbitrary boundary in the case of large, evolving systems.


## Type Annotations As Assertions

If the language is defined appropriately, static type analysis can be seen
as a set of inferences about the behavior/correctness of a program, and type
annotations can be seen as assertions about its behavior, rather than
something that is necessary to specify its behavior.  For example, in such a
language the following code:

    function f(x : Integer) {
       return x * 2;
    }

could be interpreted as equivalent to the following, given a suitable
definition of “assert”:

    function f(x) {
       assert(typeof(x) == “Integer”);
       return x * 2;
    }

The type information constrains the usage of this function, but does not
influence what it does.

By contrast, in other languages, type annotations complicate the model of
computation.  One example is function overloading.  Another example is
“backward” type propagation, in which type inference on the output of a
function can influence the types used within the function.

[An alternative to backward type propagation is passing reified types to
functions.  For example, if one wants a sum to be computed using floats, one
can write “x = sum(Float, collection)” rather than “Float x =
sum(collection)”, which results in a definition of `sum` that is explicit
and less potentially confusing.]

There may be cases where an assertion will fail that cannot be predicted by
static analysis.  Static analysis could, alternatively, ensure that it can
prove that assertions will not fail, resulting in behavior equivalent to
static type checking.  Such checks will in general forbid otherwise valid
programs; the language could provide a directive for programmers to indicate
the contexts in which this kind of checking is desired.

Another observation is that this form of static analysis does not need to be
limited to assertions about the *types* of values.  Predicting failures of
other kinds of assertion failures (or proving them impossible) would be much
more powerful than simply checking types.


## The REPL Problem

The value of interactive languages is the ability to try things and examine
outputs in order to remove uncertainty about the behavior of code.  As the
program grows, the code being explored requires a larger context (bindings
of names to values) than that of the default REPL environment.  One can
manually construct a environment in the REPL that matches the lexical
environment at a given point in a program, but the environment is different
at different places in the code.  Moving ones attention from one place to
another or modifying code changes the environment.  The effort required to
replicate a similar environment in the REPL gets out of hand as the program
grows.  Unfortunately, when things get complicated is when interactive
validation of assumptions would provide the most value.


## Interactive Value Exploration

IVE is an alternative to REPL-style interaction in a [live
programming](#live-programming), [functional](#functional) environment.

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
evaluated before its body.  (In reality, partial evaluation may actually be
used, but the observed behavior should be semantically consistent with
applicative order.)

### `defer EXPR`

On-demand evaluation can be specified using the `defer` unary prefix
operator.  For example:

    z = defer f(x/y)
    if y == 0: 0
    g(z)

Here, when `y` is 0, `f(x/y)` will not be evaluated.  When `y` is non-zero,
`g` will be called, and then, when (and if) the value of its first parameter
is ever needed, `f(x/y)` will be evaluated (at most once).

To be clear, `defer EXPR` does not specify a lazy evaluation *strategy* for
the sub-terms of `EXPR`.  In the above example, `x/y` will still be
evaluated (if at all) *before* `f` is called.  We could write `defer f(defer
x/y)` to have `x/y` evaluated on-demand during the call to `f`.


### `spawn EXPR`

The `spawn` operator is semantically equivalent to `defer`, but it acts as a
hint to speculatively begin evaluation of `EXPR` on another thread, in
parallel with the evaluation of the remainder of the program.  When and if
the value is needed, the current thread will wait on its completion, and
faults that occur within the spawned thread will be observed at that point.
If the value is never used, any results (or faults) will be discarded.

As with `defer`, faults or infinite loops in the expression will not be
observed if the value is never used.


## Top Module == Build

There should be no need for a separate [build system](#build-system) or
language.  If any artifacts are to be produced by the project -- e.g. a
command-line executable -- their construction would be described in the
language, in the "top" or "main" module file of the project.

To make this work well, we will want:

 * [Easy Parallelization](#order-annotations)
 * [Reactive programming](#reactive-programming)
 * APIs into the compiler


## Immutable Objects / Exploded Functions

A parallel can be drawn between functions, objects, and modules.

In a function body, we have a number of local variable assignments that may
build on each other, eventually used in producing the result.  Each local
assignment adds to the local environment, which is discarded at the end of
the function.

In an object constructor, we have a function body (with its local variable
assignments) and also member name/value assignments.  The result of the
function is the member bindings.  In a module, we also have local and
exported name/value bindings, and the exported bindings are the result.
Sometimes the value associated with a member/export is also used elsewhere
locally, so a brief name (as with a local variable) is used.  Collecting all
of the members/exports at the bottom may not be the most natural
organization.  Giving members/exports a different naming convention seems
awkward.

Instead, we could use a keyword (“export var = ...”) or annotation (“*var* =
...”) (a la Oberon) to indicate visibility.  We would also need to indicate
that all bindings will constitute the result.  A “bindings” construct could
surround the bindings, and evaluate to the bindings.  “{...}” or “bindings {
... }”.  Module context could default to “bindings”, rather than function
body.


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
which consitute another way for functions to return -- we should have fatal
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
typically a very blunt instrument, and without tight integration with the
language implementation it is unlikely to provide optimal performance.


## Execptions

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

In many dynamic languages we can create "unique" values -- arrays,
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

Due to immutability, variables cannot be modified, but they can be shadowed.
For example, in this code excerpt ...

    x = 1
    f = (n) => n + x
    x := 2
    ...

... the line `x := 2` does not actually *modify* a variable.  It introduces a
*new* variable, also named `x`.  Only the new `x` will be visible to lines
of code that follow.  The old `x` remains unchanged, so the behavior of `f`
is not affected by the definition that follows it.

As a shorthand for `x := x + EXPR`, we can write `x += EXPR`.  Similar
operators `-=`, `*=`, etc., are also defined.

Shadowing can be useful when a number of steps are used to construct a
single value.  It avoids the need to make up a number of arbitrary names for
the intermediate values.  This might happen more often in conjunction with
[update syntax](#update-syntax).

Shadowing is also important for [looping syntax](#looping-syntax).

Because un-intentional shadowing is a frequent source of bugs, the syntax
makes shadowing explicit.  Shadowing is disallowed when `=` isused.
Shadowing requires `:=`, `+=`, etc..


## Update Syntax

Due to [immutability](#immutability), we do not literally modify arrays or
structures, but we can construct new values that include the "modification"
we want.  Rio's update syntax allows such operations to be expressed easily:

    MEMBER_EXPR <! EXPR


MEMBER_EXPR must end in a property reference or an array/dictionary item
reference.  This syntax "peels" off the last de-reference and converts it to
a `set_prop` or `set` call.

Some examples:

    a[0] <! 1        # a.set(0, 1)
    s.c <! 1         # s.set_prop("c", 1)
    s.a.b.c <! 1     # s.a.b.set_prop("c", 1)

We combine this with [shadowing](#shadowing) and assignment syntax to allow the
following (very procedural-looking) syntax:

   MEMBER_EXPR := EXPR

In this case, MEMBER_EXPR must consist of a variable name followed by one or
more property/item references, and *all* of them are "peeled" off and
converted to set operations.

Similarly, other update assignment operators can be used:  `+=`, `-=`, etc.

For example:

    x.c := 1          <==>    x := (x.c <! 1)
                      <==>    x := x.set_prop("c", 1)

    x.c += 1          <==>    x := (x.c <! (x.c + 1))

    x.a.b := 1        <==>    x := (x.a <! (x.a.b <! 1))

    x.a[5].b := 1     <==>    x := (x.a <! (x.a[5] <! (x.a[5].b <! 1)))



## Looping Syntax

There are commonly encountered problems in programming that require
iteration, and the functional alternatives are not always the easiest way to
think about the solution.  Looping syntax provides a simple approach to
constructing loops, that uses shadowing rather than actual mutation of
variables.

Variables shadowed by assignments in a loop body will have their values
propagated to the next iteration of the loop, and when the loop exits, the
shadowed values will be propagated to the expression that follows the loop.
Within the loop body, the following expressions are defined:

  * `repeat` proceeds to the top of the loop body
  * `break` transitions to the expression after the loop
  * `while COND \ REST` is equivalent to `if not COND: break \ REST`
  * TBD: `return EXPR` bypasses REST.  (Note it "returns" from the
    loop, not necessarily the current function.)

[Perhaps it should be required that every branch of the loop body evaluates
to either `repeat` or `break`.]

Here is a simple example:

    sum = a =>
        n = 0
        total = 0
        loop while n < a.length:
            total += a[n]
            n += 1
            repeat
        total

More precisely, looping syntax translates an expression of this general
form...

    loop: BODY
    AFTER

... to this purely functional equivalent:

    _post = (VARS...) => AFTER
    _loop = (_loop, VARS...) => Substitute[BODY]
    _loop(_loop, VARS...)

... where `VARS...` is a sequence of variable names (those shadowed in the
body), and where `Substitute[BODY]` performs the following textual
substitutions:

       break        -->   _post(VARS...)
       repeat       -->   _loop(_loop, VARS...)
       while COND   -->   if not COND: break;

Translating the above example, we get:

    sum = a =>
        n = 0
        total = 0
        _post = (n, total) => total
        _loop = (_loop, n, total) =>
            if not (n < a.length):
                _post(n, total)
            total = total + a[n]
            n = n + 1
            _loop(_loop, n, total)
        _loop(_loop, n, total)

Similarly, iterating over a collection can be done with a `for` statement:

    for NAME in EXPR: BODY
    REST

For example:

    sum = a =>
        total = 0
        for n in a:
            total += a[n]
            repeat
        total


## Action Syntax

Rio provides a syntax for elegantly dealing with callbacks:

    PARAMS <- ACTION
    REST


The first line is a clause that designates the "rest" of the block as a
callback.  PARMS is a parameter list, as it would appear in a function
definition.  ACTION is an expression that evaluates to a value that
implements an `and_then` property.  The rest of the block is packaged as a
function, accepting PARAMS, that is passed to the action object.  The above
code is syntactic sugar for something like the following:

    ACTION.and_then(PARAMS => REST)

A chain of such clauses will result in a nested series of functions.  For example:


    x <- get("X")
    y <- get("Y")
    z <- get("Z")
    REST

... is equivalent to:

    get("X").and_then(
        x => get("Y").and_then(
            y => get("Z").and_then(
                z => REST)))


This could be used to describe a chain of actions to be performed
asynchronously:


   connect = (auth) =>
       (hostname, port) <- parse_authority(auth)
       addr <- gethostbyname(hostname)
       s <- socket()
       () <- s.connect(addr, port)
       OK(s)


At each `<-` clause, execution of the "rest" of the block is at the
discrtion of the action object.  This allows each action object to handle
failures by short-circuiting the rest of the chain.  This can be used as a
generic error-handling mechanism.  In the example above, we presume the
action objects short-circuit and return a Failure() value that itself is a
valid action object, so `connect` will be expected to return an action
object.  The last line uses an `OK()` constructor to wraps the successful
result in an action object.

This composesly nicely with assignments, [update syntax](#update-syntax),
and [looping syntax](#looping-syntax), as in this example:


    fetch_list = list_url =>
        list_text <- do_http("GET", list_url, {})
        urls <- parse_lines(list_text)
        items = []
        for url in urls:
            data <- do_http("GET", url, {})
            items := items.push(data)
            repeat
        items


An alternate syntax allows the programmer to specify how exceptional cases
are to be handled:

    PARAMS <- EXPR else: FAILURE
    REST

The above is syntactic sugar for:

    EXPR.and_then_else(PARAMS => REST, () => FAILURE)


For example:

    socket <- socket() else:
        Error("out of sockets")
    () <- socket.bind(INADDR_ANY) else:
        Error("failed to bind")
    () <- socket.listen(20) else:
        Error("failed to listen")



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
has its plusses and minuses, making them more or less suitable to solving
different problems.  And some languages have thei own unique tricks, or
killer features, such as language designed for use in a [build system
](#build-system).

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
addressed with a high-level language via [compile-time
evaluation](#compile-time-evaluation), [assertions](#assertions),
[hints](#hints), [typed structures](#typed-structures), and dynamic
[profiling](#profiling).

In such a language, the programmer's task during optimization is one of
demonstrating to the compiler that certain shortcuts are legitimate, rather
than grabbing the controls from the compiler.  Some examples: Type
assertions can allow the compiler to predict method lookups and inline the
methods.  The compiler can employ mutation when it knows that the data
structure is not shared, and a programmer could maximise this by being aware
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
clearly specified behavior.  JavaScript's HashMap enumeration behavior is a
good example of avoiding undefined behavior.

Under no circumstances is it acceptable to use the C language's "all bets
are off" definition of undefined behavior. When you cannot place any bounds
around the implications of an isolated programming mistake, you cannot come
to any meaningful conclusions when analyzing a large code base.

Another consequence of undefined behavior is that the C language is
effectively unstable.  C programs that compile today might not compile
tomorrow.  The reason is that C is not inherently safe, but still some
unsafe usage can be identified by the compiler and reported as a "warning".
In fact they go further and report warnings based on circumstantial evidence
when there many not be an actual bug.  The compiler can never detect all
unsafe usage, but it can get "better" at it over time, so more warnings show
up with newer compiler versions.  Due to the catatrophic consequences of
unsafety, any responsible developer treats warnings as errors, so when new
warnings show up they break the project.  The set of things forbidden by
warnings constitute a de facto language definition ... a language that is
unspecified, constantly changing, and that differs from compiler to
compiler.


## Typed Structures

Dynamic languages typically provide free-form data structuring mechanisms
that allow a variable number of fields, each of which can hold any type of
value.

However, dynamic languaes are not incompatible with the notion of typed
structures and arrays, which can allow a precise, efficient memory layout.
The best example of this is LuaJIT and its C FFI, which can actually be used
to great effect without ever calling into C.  Another example is
JavaScript's typed arrays.

These typed structures do not manifest as static declarations and typing
constraints on variables.  Instead, they are created at run-time, either by
first creating a [reified type](#reified-types) and then instantiating it,
or by directly creating an instance.  Rio uses reified types.


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

Since memoization seems to inherently involve stateful side effects, so how
do we have it in a purely function language?  Answer: We consider the state
as part of the [execution context](#execution-context).  It is not
observable by code running *within* that EC, so that code retains its
functional purity.  The EC itself explicitly deals with that state, not as a
side effect.

One problem is cleanup.  If we collect prior results indefinitely, we run
out of resources over time.  We can associate the memoization cache with a
[reactive programming](#reactive-programming) graph node -- visible to the
EC, not the code it hosts.  Node "liveness" will control the lifetime of the
memozation cache.  Together with [deterministic garbage collection
](#deterministic-garbage-collection) this can ensure proper cleanup.  [This
works for results accumulated over multiple reactive evaluation cycles;
within any one evaluation cycles, all memoized results would accumulate, but
I dont think this is the problematic case.]


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

That leaves us with the downsides: extra syntax for the user to maintain (in
addition to indentation), and visual clutter.  Delimiters are clutter
because the user already has seen the 2D structure before their brain gets
around to locating and matching up keywords or symbols like braces.


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
