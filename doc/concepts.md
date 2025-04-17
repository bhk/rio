# Rio Concept Map

## Language Overview

The Rio language is intended to minimize the [Think-Do Gap](#think-do-gap)
by minimizing complexity, and by supporting [intrinsic
reactivity](#intrinsic-reactivity) and [live
programming](#live-programming).

The [syntax](#syntax-overview) is intended to be readable and simple.

The language semantics are characterized by the following design choices:

 * [Immutability](#immutability)
 * [Lexical scoping](#lexical-scoping)
 * [Duck typing](#duck-typing)
 * [Friendly Data Types](#friendly-data-types)
 * [Typed Structures](#typed-structures)
 * [Gradual Typing](#gradual-typing)
 * [Intrinsic Reactivity](#intrinsic-reactivity)

Think of a Lisp-like core, with Smalltalk-like duck typing, but without
mutation.  And with some Python-like syntax.  And with an implementation
that heavily leverages inlining and [early evaluation](#early-evaluation).

Rio design and implementation is influenced by [early
evaluation](#early-evaluation).


## Syntax Overview

Here is Rio's "inline" syntax summarized with some examples:

 - Numeric and string constants:  `1`, `1.0e4`, `"hello"`
 - Variables: `x`, `foo_bar`, `FooBar`
 - Infix expressions:  `a + b * c`
 - Prefix operations:  `not a`,  `-x`
 - Function construction: `(x) -> x * 2`
 - Function application: `f(x, y)`
 - Vector construction: `[x, y, z]`
 - Vector de-reference: `a[n]`
 - Map construction: `{a: 1, b: 2, c: 3}`
 - Property de-reference: `r.prop`

Refer to [`syntax.md`](syntax.md#grammar) for all the gory details.

Rio's "block-level" syntax uses [indentation](#2d-syntax) to convey code
structure.  A block-level expression consists of a line of text and includes
all the immediately following lines that are more-indented.  A block-level
expression can consist of an inline expression or any of the following:

 - [Assignment & conditional expressions](#vertical-syntax)
 - [Match expressions](#pattern-matching)
 - [Imperative expressions](#imperative-syntax)

For example:

    f = (a, b) ->
        if x < 1: 0
        total = 0
        loop while x < 10:
            total += x
            x += 1
        total

## Vertical Syntax

Rio syntax supports a "vertical" program structure, so that code reads down
the page instead of diagonally down-and-to-the-right.  Likewise, data flow
(during execution) generally progresses down the page, which can help with
readability of the code.  It also is important for usability in a
worksheet-based [live programming](#live-programming) environment.

Assignment expressions consist of a `NAME = EXPR` line followed vertically
by a `BODY`.  The variable will visible only in `BODY`.  If the variable has
previously been assigned a value, this new assignment will *shadow* the
previous assignment, rather than *modify* it.

Conditional expressions consist of `if COND: THEN-EXPR` followed vertically
by `ELSE-EXPR`.  Each "logical" line can be split across physical lines by
indenting the continuing lines.

For example, the following Lisp code:

    (if P
        A
        (if Q
            (let ((x EXPR))
                (let ((y EXPR2))
                    (* x y)))
            B))

... is equivalent to the following Rio code:

    if P: A
    if Q:
        x = EXPR
        y = EXPR2
        x * y
    B


## Pattern Matching

A `match` expression selects between multiple alternatives, potentially
de-structuring aggregates and binding names.

    match Value:
       Pattern => Expr
       Pattern => Expr

A `Pattern` can be one of the following:

 - A name: This will match any value.  When the corresponding `Expr` is
   evaluated, the value is bound to the variable of that name.

 - A constant: A literal number or string will match only that value.

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


## Imperative Syntax

A number of features that resemble imperative programming, but without the
pitfalls of mutable data, are implemented as syntactic sugar.

 * [Update Syntax](#update-syntax)
 * [Looping Syntax](#looping-syntax)
 * [Action Syntax](#action-syntax)


## Update Syntax

Due to [immutability](#immutability), we do not literally modify vectors or
structures, but we can construct new values that include the "modification"
we want.  For example, the `set` method of vectors and the `setProp` method
of maps can be used to "replace" a member:

    v = [1,2,3]
    v := v.set(1, 7)            # --> [1,7,3]

    m = {a:1, b:2, c:3}
    m := m.setProp("b", 5)      # --> {a:1, b:5, c:3}

Rio's update syntax allows such operations to be expressed easily,
by extending the notion of shadowing assignments.

    MEMBER_EXPR := EXPR

In this case, MEMBER_EXPR must consist of a variable name followed by one or
more property/item dereferences. All of the dereferences are "peeled" off
and converted to set operations.

Similarly, other update assignment operators can be used:  `+=`, `-=`, etc.

For example:

    x.c := 1        <==>  x := x.setProp("c", 1)

    x.c += 1        <==>  x := x.setProp("c", x.c + 1)

    x.a.b := 1      <==>  x := x.setProp("a", x.a.setProp("b", 1))

    x[2][5].b := 1  <==>  x := x.set(2, x[2].set(5, x[2][5].setProp("b", 1)))


## Looping Syntax

Looping syntax provides a simple approach to constructing loops, that uses
shadowing rather than actual mutation of variables.

Variables shadowed by assignments in a loop body will have their values
propagated to the next iteration of the loop, and when the loop exits, the
final values will be visible to the expression that follows the loop.

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

Within the loop body, the following are defined:

  * `repeat` skips the rest of the loop body, and proceeds directly to the top
    at the next iteration.
  * `break` transitions to the expression after the loop
  * `while COND` is equivalent to `if not COND: break`.  This can be used to
    construct a loop with one or more exit conditions somewhere in the
    middle.


### Loop Syntax Details

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

Translating the above `sum` example, we get:

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

At each `<-` clause, execution of the remaining lines in the block is at the
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
begin a new indentation level.  Text that introduces a multi-line block --
assignments, `if` statements, etc. -- can easily be distinguished from other
lines.  Such lines begin a new block, and other such lines are treated as
continuation lines.


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


------------------------------------------------------------------------

## Immutability

Data structures and variables are immutable in Rio.  There are a number of
reasons to forbid mutation in a language.

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
where the language can easily identify the cycles at the time of
construction.

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


## Lexical Scoping

With lexical scoping rules, the visibility of a variable can be easily
determined by looking at the structure of the source code; it does not
require analyzing the dynamic execution paths of the program.

Rio uses lexical scoping.  There are no "global" variable names, except for
a few symbols built into the language that are manifest within each module.
One of these, `require`, is used to import other modules, as in:

    foo = require("foo.rio")
    x = foo.fn(...)
    ...

In Rio syntax, a variable's scope is the rest of its block.  The "rest of
its block" corresponds to all the subsequent consecutive lines of code that
are indented as much as or more than its assignment statement.

When two or more variable assignments use the same name, they define
different variables (that happen to have the same name).  Where their scopes
overlap the nearest (last) definition supersedes and is said to "shadow" the
earlier ones.


## Duck Typing

Duck typing is a form of [dynamic typing](#dynamic-typing) in which the
behavior of a value is described entirely by the interface it exposes.  Rio
supports this through a consistent, thorough application of [dynamic
dispatch](#dynamic-dispatch).  Every data type exposes its behavior through
a set of [properties](#properties).

Here is one illustrative example: `a + b` is defined as invoking the "+"
[method](#methods) of `a`, passing it `b`.  This contrasts with dynamic
languages that define "+" as a built-in function with special cases for
built-in types.

The main benefit of this approach is to maximize the power of user-defined
data types.  They are treated as first-class citizens.

Rio built-in types are special only in that they supply the functionality of
values constructed from literal constants, or via vector or map expressions.
After construction, they have no special privileges or capabilities.


## Properties

The `.` operator can be used to access properties whose names are valid
identifiers in the Rio syntax.  Other properties with special names have
special purposes.

Rio's infix operators are defined in terms of properties.  Assuming a
hypothetical function called `get_property` that allows direct access to all
properties...

    x + y    <==>   get_property(x, "{}+")(y)

Member access is done via a property:

    a[k]     <==>   get_property(a, "{}[]")(k)

Abstract data types are constructed by providing an implementation of
`get_property` for that type.

    gp = (self, name) -> ...
    new_type = derive(old_type, gp)

Properties express essentially all of the behavior of a value, except for
function invocation.  [Note: Maybe a distinction can be made between
"surface" properties and other behavior. In any case, all aspects of a
value's behavior should be implementable in the language.]


## Methods

A "method" is nothing more than a property that evaluates to a function.
The expression `a.foo()` is equivalent to `tmp = a.foo; tmp()`, exactly as
logic would dictate (but unlike as in some other programming languages).

Rio does not confuse properties of values with members of collections.
Indexing expressions -- e.g. `value[index]` -- access "members" of a vector
or map, not "properties".


## Dynamic Typing

Dynamic languages present a simple mental model of execution, making them
relatively easy to learn and use.  One does not need to first learn a
complex type system to understand how the language works.

Functions in a dynamic language are inherently polymorphic.  Without
polymorphism we end up writing essentially the same function again and
again.  Statically typed languages employ complex type systems to enable
polymorphism to a reasonable, but still limited, extent.

Large projects in statically typed language often end up implementing their
own mechanisms that mimic a dynamic language (see Greenspun's Tenth Rule).
Reflection is probably a common motivation for this.  For example, consider
how you would write function that will serialize *any* data structure in
your favorite statically typed language.


## Dynamic Dispatch

Functions or “methods” may be associated with a type, and may be retrieved
via a value of that type.

The name "dynamic dispatch" describes how a conceptual virtual machine
might interpret expressions, and it implies an implementation choice of
using run-time method lookup, but it does not prevent a compiler from
optimizing away a lookup when it can predict the type of the value.

We rely on [early evaluation](#early-evaluation-of-constructors) of
[type-specialized functions](#specialization) to optimize away method lookup
overhead.


## Typed Structures

Dynamic languages typically provide free-form data structuring mechanisms
that allow a variable number of members, each of which can hold any type of
value.

However, dynamic languages are not incompatible with the notion of typed
data structures.  These allow for highly efficient memory layout and
performant code.  The best example of this is LuaJIT and its C FFI, which
can actually be used to great effect without ever calling into C.  Another
example is JavaScript's typed arrays.

The *behavior* of a typed data vector or record -- what properties and
operations are available -- will mostly match that of its untyped
equivalent.  The chief difference is that construction and mutation-like
methods will restrict, at run time, member values to the designated type.
For example, `v[0] = 7` will always replace the first element with *number*
`7` when `v` is an untyped vector, but it may trigger a type conversion or
exception when `v` is typed.

Typed structures do not complicate Rio syntax.  These values are created at
run time using constructors, mutator-like operations, and/or untyped arrays.
For example:

    a = Vector(I32)([1, 2, 3])

We rely on [early evaluation of
constructors](#early-evaluation-of-constructors) to ensure high performance.


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
those of other dynamic languages.  For example, mismatches between formal
and actual argument counts generate a run-time error, as do accesses of
undefined vector or map members.  There are fewer [implicit type
conversions](#implicit-type-conversions), and no "null" value.


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


## Intrinsic Reactivity

**Intrinsic reactivity** refers to Rio's built-in support for [reactive,
incremental evaluation](incremental.md).  Unlike the conventional
[callback-based approach](incremental.md#the-notification-problem), change
is treated as a cross-cutting concern that does not require restructuring
code, and may or may not require any special considerations on the part of
the programmer.

A simple example is that of expressions in a Rio module viewed in the Rio
IDE.  Below `1 + 2` will be displayed the result `3`.  `1 + timeOfDay`,
however, will display some number that continuously increments.  There is no
need to implement an object that registers for notifications from a
timeOfDay object, and in turn supports its own registration mechanism so
other objects can observe its changes.

Extending this to arbitrarily complex Rio programs takes some imagination.
Consider the following hypothetical Rio commane-line program, which makes
use of a compiler toolchain written entirely in Rio:

    C = load("c-compiler.rio")
    o1 = C.compile("foo.c")
    o2 = C.compile("bar.c")
    e = C.link([o1, o2])
    write(e, "a.out")

The result of the final expression is an action object that accepts an
reactive computation whose value will initially be an exception that
indicates its in-progress status, and will later transition to the compiler
output, which will complete the action.

Other types of Rio programs perhaps require more imagination.  Long-lived
servers, for example, are programs that continually consume a stream of
input events, generating a stream of output events.


## Orchestrators

**Orchestrators** are functions that control when and how expressions are
evaluated.  Their result has the same value as their argument, but the
computation of that result might be deferred, parallelized, or cached.

Since the point of orchestrators is to influence the evaluation of their
argument, their [names end in "&"](#lazy-expressions) to defer that
evaluation.

Examples:

 * `&(EXPR)`: Returns its first argument: a deferred computation.

 * `spawn&(EXPR)`: Launches a parallel task to evaluate `EXPR`, returning a
   deferred computation that waits on the result.

 * `memo&(EXPR)`: A memoized expression, evaluated within a [reactive
   cell](incremental.md#how-it-works).  The result is a deferred
   computation.

Regarding memoization, `&(EXPR)` and `memo&(EXPR)` differ in a subtle way.
`&(EXPR)` constructs a deferred computation that will evaluate `EXPR` at
most once, but multiple evaluations of `&(EXPR)` will construct multiple
deferred computations, each of which can result in an evaluation of `EXPR`.
Multiple evaluations of `memo&(EXPR)`, on the other hand, will return the
*same* deferred computation as long as all the free variables in `EXPR`
refer to the same values.


## Lazy Expressions

Rio's [eagerly evaluates
expressions](https://en.wikipedia.org/wiki/Evaluation_strategy) by default,
but when a function whose name ends in "&" is called, its arguments are
treated as lazy expressions.  The function will receive a deferred
computation for each argument.  These will be computed at most once, when
and if needed.  They can be assigned to variables and passed to functions
without forcing their evaluation.

Any operations or use of properties or methods will force their evaluation.
There is no need to explicitly force evaulation, and the deferred nature
does not affect the type of the value.

Any errors or infinite loops in the expression will not occur if the value
is never used.  If the value is used and they do occur, they will manifest
at the point of first use.

Note that while evaluation of the lazy expression is deferred, the
evaluation strategy within the expression does not change, so once
evaluation is forced, all its subexpressions will be evaluated (unless they
in turn contain other lazy constructs).

Finally, note that it is the *name* of the variable (or member) used to call
the function, as it appears in the source code at the call site, that
controls this behavior.  It is not a property of the function itself.


## Hints

Hints are statements in the code that do not affect the results of the
program, but may affect optimizations.  For example, a hint may suggest
additional optimization, or focus it on specific kinds or ranges of values.

Hints align with Rio's goal of *enabling* programmers, rather than
second-guessing them.


## Objects

The syntax or mechanism for defining methods is TBD.


## Interfaces

The set of behaviors that define a data value constitute its interface.
This includes named properties (using the `.` operator), behaviors
associated with infix operators, and meta-properties (e.g. enumeration of
named properties).

A given data value may be accessed via more than one interface.  A mechanism
like COM's QueryInterface can be used to interrogate values and obtain
interfaces.

Wrapper interfaces can also be constructed, adapting objects written for one
"dialect" to another.


------------------------------------------------------------------------


## Early Evaluation

*Early evaluation* refers to to performing computations "out of order", so
that we can avoid performing them multiple times.  We might compute a
sub-expression once before entering a loop, rather than per-iteration, or
once when a function is constructed, rather than every time it is called, or
once when compiling a program, rather than every time the program is
invoked.

Even when we do not know the precise value of a dependency, we may have
some partial knowledge that will enable early evaluation.  For
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

Early evaluation is especially relevant to the language design of Rio
because it allows us to have "nice" semantics without incurring unreasonable
performance costs.

1. It can predictably optimize away some overheads associated with dynamic
   languages.  For example, when the type of a value is known, [method
   lookup](#dynamic-dispatch) can be done early, and type information can be
   "erased" from the generated code.

2. We can avoid the language complexities of a macro system and preprocessor
   directives, and free the programmer from the mental gymnastics required
   for meta-programming, while retaining the run-time benefits.

3. The fact that variables and data structures are
   [immutable](#immutability) in Rio makes early evaluation particularly
   fruitful.  For example, the functions imported by a module will generally
   be known statically, enabling inlining or [specialization] of those
   functions.  This allows us to use functions as [zero-cost
   abstractions](#zero-cost-abstractions).

4. Symbols exported from modules are known at "compile time", avoiding
   run-time lookup costs and enabling inlining where appropriate, without
   complicating the language with a special class of [top-level
   code](#top-level-code).


## Early Evaluation of Constructors

An implication of [early evaluation](#early-evaluation) that has implication
on language design is the optimization of constructors.  This reduces the
pressure to complicate the language with grammar for literals of various
types, or a turing-complete macro facility, or backward-in-time type
inference.

For example, regular expressions can be constructed from a string...

    regex = RE("a(.*)b+")

... can be evaluated once -- at "compile time", if you will -- without
hardcoding the syntax or semantics into the language.

A couple of general-purpose data structuring features in the syntax --
heterogeneous arrays and records -- allow for efficient construction of an
unlimited number of complex data types, some highly performance-oriented.
For example:

    V32 = TypedVector(Uint32)
    v = V32([1, 2, 3])

Here, an untyped vector (a vector of `Any`) is being constructed and then
passed to the `V32` constructor, which then packs the values into a typed
vector.  At "run time" this manifests only as a constant vector of 32-bit
values.


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


## "Compile Time"

The term "compile-time" is potentially confusing.  Originally, compilation
was the process of translating source code, stored in one or more text
files, to machine code, stored in an executable file.

In a Rio *worksheet*, the user sees the results immediately, and those
results update as the program is modified.  The user does not explicitly
initiate compilation, and does not see an executable file, and in general
there is not one.  However, the Rio runtime may be generating machine code
in a just-in-time (JIT) manner in order to execute the program most
efficiently.

If the user so desires, Rio can also generate "executable" files.  These are
self-contained files that can be deployed independently of the source files.
This executable file might contain WebAssembly code (or machine code in some
future incarnation), but it also might contain more abstract code
representations that get JIT compiled at run-time (in which case it would
also contain the code to perform that compilation).

The traditional sharp distinction between compile time and run time is
reflected in terms like "compile-time evaluation" (CTE).  In Rio, we use the
term [early evaluation](#early-evaluation) to encompass CTE and
pre-compilation transformations of the code.

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

Rio follows the dynamic language model, like languages such as JavaScript,
Python, and Lua, wherein top-level code is not special, it is the same as
function body code.  Loading a module executes the body of the module.

Note that due to [early evaluation](#early-evaluation), module loading can
be done at "compile time", so values exported by a module and consumed by
another will not necessarily occur any run-time lookup penalty, and may even
be inlined.


## Profiling

We can observe execution of code to collect information and feed it back
into the compilation stage to direct optimizations.  Execution frequency can
point to where optimizations are worthwhile.  Observed data types and values
can suggest opportunities for [specialization](#specialization).


## UI Development

Updating parts of the display as system state change typically involves
writing listener-related code: register for notifications, handle
notifications, de-register, handle registrations and deregistrations,
deliver notifications.

The amount of code required for a task is minimized by [reactive
programming](#intrinsic-reactivity).

The immediate feedback provided by [live programming](#live-programming)
makes the process of programming easier and more enjoyable.


## Live Programming

In live programming, the user can see immediately the results of code as it
is typed.

The implementation of such an environment could benefit from [intrinsic
reactivity](#intrinsic-reactivity).

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

- Allow rich text comments, with some graphing capability.

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


## Resource Lifetime Management

Back in the dark ages of computing, the legend goes, programmers explicitly
managed memory allocation.  They would call a function like `malloc` to
obtain the memory needed for a data structure, and they would call `free` to
return memory to the pool after it was no longer needed by the program.
Enter garbage collection (GC).  Initially considered a hack, it proved
workable and provided enormous benefits by freeing the programmer from the
need to manually manage the lifetimes of memory blocks.

Unfortunately, GC does not solve every lifetime management problem.  For
example:

 - Unless the GC is [deterministic](#deterministic-garbage-collection), we
   cannot rely on it to discard objects that represent non-memory resources.

 - Objects that register for notifications will be referenced by objects
   other than their "owners", and that will make them considered "live"
   (reachable) by GC even when their "owners" go away and they serve no
   useful purpose.

 - In a distributed environment, remote object invocation can be used to
   simplify communication between two software environments.  When GC
   operates on one of the environments, it can only deal with reference
   cycles that are fully contained in its own environment.  GC must treat
   all objects referenced from the other environment as reachable.  If we
   have a reference cycle that spans the communication boundary, GC will not
   be able to clean them up, even when both environments individually
   support GC.

This often means that programmers are left with the need to perform explicit
lifetime management.  Unfortunately, this requirement is contagious.  If we
object's destructor must be called, then all objects who "own" it must
perform that duty ... which mean they in turn have destructors that must be
called by any object that owns them ... and so on.  Any data structure that
takes ownership of values, in order to be fully generic, must participate in
some lifetime management strategy for the things it contains.

Rio fixes this, through a combination of features:

 - [Deterministic garbage collection](#deterministic-garbage-collection).

 - [Intrinsic reactivity](#intrinsic-reactivity) avoids the need for
   reference cycles introduced by the [callback-based
   notifications](incremental.md#the-notification-problem)

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


## Inline Tests

Unit tests should appear alongside (immediately after) the function being
tested.  As the module is loaded (executed), the tests run, so the
validation occurs before consumers are exposed to the module.  Putting tests
inline allows non-exported functions to be tested, and it ensures and
documents the validation.

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


## Floating Abstractions

When a set of abstractions are defined entirely in terms of themselves, we
say they are *floating abstractions*.  This is a generalization of the
notion of a circular definition to the case a multiple, mutually-referencing
definitions.  Truly floating abstractions are effectively meaningless.

More commonly, we encounter sets of abstractions that are *mostly* floating
... they actually have definite meanings, but the clues that ground them are
scattered and scarce.  When confronted with such a description, someone
attempting to understand them is left to grasp with various potential
meanings, working through the implications to eliminate the ones that do not
hold together.  This is akin to solving a system of equations in linear
algebra.  Given enough independent equations (assertions about the
abstractions), we can solve the system, but the effort required in solving
increases dramatically with the number of variables.


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


## Integrated Builds

There should be no need for a separate build system and build language.  Rio
should suffice as a language for describing what is to be built, and for
efficiently performing the build.  Since, the key competency of a build
systems is enablement of parallel and incremental processing, these Rio
features will be important:

 * [Easy Parallelization](#orchestrators)
 * [Intrinsic reactivity](#intrinsic-reactivity)
 * APIs exposed by the compiler


## Errors

The language must provide a means for trapping and handling errors.  After
all, we cannot have one memory allocation failure take down our whole world.
Some parts of our world must be able to deal with failures in other parts of
our world, whether it be assertion failures, memory allocation failures,
non-terminating loops, or other exceptional conditions.  We cannot ignore
the computation aspect of computation.

A language that leaves these responsibilities to user libraries provides an
incomplete set of tools to the programmer.  To evaluate such a language we
must consider it together with some such library.  OS processes are
typically a very blunt instrument, heavyweight, and non-portable.

We do not need to provide a notion of "exceptions" as a lightweight, general
purpose programming tool -- that is, something that one would use in the
course of a successful computation.

Errors will halt execution and record where the execution was halted, so
that they may be inspected.  At some higher scope, however, execution will
continue.  The scope of execution that is halted we will call a "cell",
similarly to the notion of cells in the `memo`
[orchestrator](#orchestrators).  Perhaps a `try&(EXPR)` orchestrator will
provide the containing expression with either a "Success(...)` or
`Error(...)` variant result.


## Inner Evaluation

A program running in the VM should be able to run other code in the VM.
What would this look like?

1. A function that accepts source and translates it to an AST.

2. A function that accepts and AST and and environment converts it to a
   native function.

The native function can then be called directly, but there is more
functionality that the interpreter might provide, such as the ability to
monitor progress, set breakpoints, and inspect execution state or errors.

The ability to monitoring progress and status is akin to what `spawn` and
`try` [order annotations](#order-annotations) would provide.

However, the ability to peer inside the executing code should require
additional *capabilities* beyond that of possessing a function reference.
We could allow an instance of the interpreter to be constructed from an AST.
A root environment will also be required and any functions within it are of
concern.  Perhaps we could restrict functions in this environment to a set
of interpreter-provided primitives.


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

In order take to advantage of a Rio feature that exists in P2 but not in P1,
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
task that is unavoidable.  This is the "think" part.

However, the task of producing working code -- the "do" part -- inevitably
involves additional work.  Tools, libraries, and languages bring along
complexity and bugs, and they often require us to say the same thing
multiple times, or solve the same problem again and again.  Here are some
notable challenges:

 - [Too Many Languages](#too-many-languages)
 - Complexity
   - Complicated mental models of execution.
   - [Undefined Behavior](#undefined-behavior)
   - [Top-Level Code](#top-level-code)
   - Macro languages, and/or meta-programming.
   - Frameworks and libraries that require us to "repeat ourselves".
 - Un-hygienic language constructs and libraries.
 - Lack of [intrinsic reactivity](#intrinsic-reactivity).
 - Lack of [zero-cost abstractions](#zero-cost-abstractions).
 - Limited [polymorphism and reflection](#dynamic-typing).
 - Lack of observability.


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

Much of the proliferation of languages is entirely accidental.  Many
projects make use of three or more of {Python, Ruby, PHP, JavaScript} ...
languages that differ mainly in superficial details.

On the other hand, sometimes there are deficiencies that make a language
less suitable for a partciular purpose.  Compiled languages typically lack
reflection and run-time extensibility, while interpreted languages lack
performance.  Some languages lack the ability to gracefully recover from
out-of-memory conditions, infinite loops, or unexpected bugs, so we end up
partitioning responsibilities into different executables and gluing them
together with a shell language.  And most languages, outside of some created
specifically for build systems, lack any inherent notion of dealing with
changing inputs.

Of course, creating one more language will not reduce the number of
languages that exist, but a new language that answers all these use cases
could enable new projects to minimize these costs.


## Completeness

In order to avoid the morass of [too many languages](#too-many-languages),
we need a language that includes the following features:

 - Safety: no [undefined behavior](#undefined-behavior) in the C sense of
   the term.

 - Exception handling: the ability to contain and gracefully recover from
   out-of-memory conditions, non-terminating loops, and unexpected bugs.

 - [Gradual typing](#gradual-typing)

 - [Intrinsic reactivity](#intrinsic-reactivity)

 - [Standalone sources](#standalone-sources)

 - Portability: the implementation should be easily ported to various
   hardware platforms, and the web.

 - [Performance](#performance)

 - Reflection

 - Run-time extensibility


## Performance

Given an arbitrarily complex compiler, Rio performance could approach that
of the low-level languages, but the objective of the project is to obtain
reasonable performance with a small implementation.  Some characteristics of
Rio should make it easy to approach reasonable performance, while at the
same time making it more difficult to match that of low-level languages.

Challenges include:

 - Immutability.  Operations that might otherwise be accomplished by a small
   modification to a data structure instead require constructing a new copy.

 - Dispatch costs: Duck typing and the dynamic natures of the language
   can introduce a run-time overhead.

Benefits include:

 - Immutability.  This makes it easy for the compiler to infer information
   that enables optimizations.

 - Parallel annotations.  These make it easy for a developer to leverage
   multiple threads.

Strategies:

 - Support just-in-time compilation.

 - Enable typed aggregates.

 - Perform early evaluation.  Immutability should make this technique very
   effective.

 - Type-specialization of compiled functions should ameliorate method
   dispath overhead.  With appropriate library design, knowledge of types of
   input values should almost always confer knowledge of the types of output
   values, so that a type-specialized implementation will be able to call
   (and inline) type-specialized forms of the functions it calls.

 - Lifetime analysis to enable low-level mutative code to be generated by
   the compiler, avoiding allocation and copying.

The performance goal is to enable the bulk of a project to be written in
Rio.  The ability to spawn other processes and communicate with them (when
running on a native OS, not the browser) will be important for some
high-performance operations.


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


## Reified Types

In a language with reified types, a type is a "first-class" value.

Reified types allow types to be constructed programmatically.  For example,
a combinator-based parser generator could construct not just parsing
functions, but the data types that hold the results.

This allows many of the benefits of meta-programming without the downsides
(mental gymnastics, workflow complications).


## Memoization

Memoization is important for [intrinsic reactivity](#intrinsic-reactivity),
to allow results at T(N+1) to reuse results calculated at T(N).

Since memoization seems to inherently involve stateful side effects, how do
we have it in a purely functional language?  We can address this by
considering the memoization cache as state managed by an instance of the
interpreter.  Those state changes are not observable by code running
*within* that instance, so that code sees no side effects and retains its
functional purity.


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

Strings are [typed](#typed-structures) vectors of 8-bit unsigned integers.

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
