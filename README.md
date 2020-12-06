Rio is the working name for a project to create a programming language,
compiler, and graphical interactive development environment.

The immediate motivation for Rio is to explore reactive evaluation, and how
that might streamline UI development.  To that end, a simple language with a
pure functional foundation, without mutation, appears to be best suited.

However, there are a lot of other ideas I've had over the years for a
programming language and deveopment environment, and this is an opportunity
to try them out as well: Compile-time evaluation, partial evaluation,
specialization, reified types, gradual typing, treating static typing as
assertions, integrated unit testing.  Together with reactive evaluation,
they reinforce and suport each other, creating more than the sum of the
parts.  If this works out, we'll have a language that spans the divides
between dynamically-typed and statically-typed, compiled and interpreted,
high-level and low-level, offering the best of each domain.

The "concepts" document contains notes on a lot of these ideas, as well as
[an introduction to Rio syntax](#syntax-introduction) and some [Rio
internals](#rio-internals).
