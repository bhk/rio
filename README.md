Rio is the working name for a project to create a programming language,
compiler, and interactive development environment.

The immediate motivation for Rio is to explore live coding and "intrinsic
reactivity".  To that end, a simple language with a pure functional
foundation appears to be best suited.  At the same time, there are a lot of
other ideas that I believe support and reinforce each other along with
reactive evaluation and immutable data structures, creating more than the
sum of the parts: Compile-time/partial evaluation, reified types, gradual
typing, treating static typing as assertions, integrated unit testing.  If
this works out, we'll have a language that spans the divides between
dynamically-typed and statically-typed, compiled and interpreted, high-level
and low-level, offering the best of each domain.

The ["concepts"](concepts.md) document contains notes on a lot of these
ideas, as well as [an introduction to Rio
syntax](concepts.md#syntax-overview) and a high-level
[overview](concepts.md#language-overview) of the semantics.
