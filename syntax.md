# Rio Syntax


Rio syntax is best described in terms of two stages or layers.  There is a
"2D" syntax that imparts a high-level structure to the program, dividing it
into "blocks" and "logical lines", and an "inline" syntax that describes the
structure of the text within those logical lines.


## 2D Syntax

A *module* is a sequence of characters (for example, as read from a source
file) parsed as a single entity.

A *physical line* is a sequence of characters ending in an ASCII LF
character.  For the purposes of this section, we ignore empty lines and
those that contain only whitespace or comments.

*Blocks* -- sequences of indented lines -- are identified during parsing.
We begin with an implicit block, having an indentation of 0, that encloses
all the text in a module.  Indentation is measured by counting the number of
leading space characters in a line.  Tab characters and other control
characters are disallowed.

Text within a block is grouped into *logical lines*. A logical line begins
with a physical line whose indentation matches that of the block, and
extends to include all subsequent contiguous physical lines that are
indented more than that.

Additional blocks begin where a line is encountered that (a) is indented
more than its parent block and (b) contains a statement (discussed below).
The indentation of that line defines the indentation of a new, nested block
that includes all subsequent, contiguous lines that are indented that much
or more.  Physical lines that are more indented than the first line of a
logical line but are not part of a nested block are called continuation
lines.

The logical structure of a Rio module, therefore, is a block; blocks are
sequences of logical lines; logical lines are sequences of physical lines
and/or blocks.


## Inline Syntax

A logical line is a sequence of text and/or blocks.  The line boundaries
between physical lines are treated as whitespace and have no other
significance.

Logical lines may contain statements or inline expressions.

A *statement* is a logical line that must be followed by one or more logical
lines in the same block.  It does not constitute a complete expression by
itself, but when combined with the "rest" of the block it does.

    if cond:           # statement first line       \   "vertical"
      true             #   statement continuation    >  expression
    REST               # remainder of block         /

Statements begin with one of a small number of keywords (`if`, `loop`,
etc.), except for assignment statements, which are easily identified by
their assignment operators.

An *inline expression* (ILE) is a complete expression on its own.  Every
block ends in a logical line that consists of an ILE.  ILEs use a fairly
conventional syntax with infix operators, function calls, etc.

When a logical line that is *not* the last one in its block consists of an
ILE, that ILE is ignored as if it were not present in the module.
Extraneous ILE's such as these can be available for inspection in a live
programming environment, but they will not affect the behavior of the
program.


## Grammar

Below is a fairly complete grammar for the inline syntax.  The `LogLine`
expression is used to parse a logical line, after it is identified by the 2D
syntax.  `Expr` matches an inline expression (ILE).  The `Comment`
non-terminal is used by the 2D syntax to recognize (and skip) comment-only
lines.

The notation used is from PEG[1], with some added conveniences:

 1. We use `,*` as a postfix operator.  `P,*` matches a sequence of zero or
    more comma-delimited instances of `P`.  A comma is allowed after the
    last item.

 2. Strings quoted with double-quotes imply "token-like" behavior depending
    on the "kind" of characters contained.  We define three kinds:
    delimiters (`(){}[]":;,`), name characters (letters, digits, and `_`),
    and punctuation (all other non-space printable ASCII characters).  Name
    and punctuation tokens must not be followed by a character of the same
    kind.  All tokens consume any whitespace and/or comments that follow
    them.

----

    LogLine   <- Statement / Expr

    Comment   <- '#' (!'\n' .)*

    Statement <- Name LetOp Expr
                / Params "<-" Expr
                / "if" Expr ":" Expr
                / "loop" ":"
                / "loop while" Expr ":"
                / "for" Name "in" Expr ":"

    LetOp    <- "=" / ":=" / "+=" / "++=" / "*="

    Expr     <- Params "=>" Expr
              / Operations

    Params   <- Name
              / "(" Name,* ")"

    Atom     <- Number           # 1.23
              / String           # "abc"
              / Variable         # var, true, false
              / Vector           # [1,2,3]
              / Record           # {a: 1, b: 2}
              / "(" Expr ")"     # (1 + 2)
              / Block            # [from 2D syntax]

    Vector   <- "[" Expr,* "]"

    Record   <- "{" (Name ":" Expr),* "}"

    Variable <- !Keyword Name
    Keyword  <- ("and" / "or" / "not" / "if" / "loop" / "while" / "for") !NameCh

    Name     <- ![0-9] NameCh+ Spacing
    NameCh   <- [a-zA-Z0-9_]

    Number   <- [0-9]+ ('.' [0-9]+)? ([eE] [0-9]+)? ![a-zA-Z.] Spacing

    String   <- ["] StringCh* ["] Spacing
    StringCh <- !["\\] . / '\\' [\\"nrt]

----

Additional definitions:

`Spacing` skips whitespace and comments, if present, but does not read
beyond the end of the current logical line.

`Block` matches a nested block, as defined by the 2D grammar.  Note that
`Block` will recursively match `LogLine`.

The `Operations` non-terminal refers a parsing expression that recognizes
infix, prefix, and suffix expressions built on `Atom`s.  The operators are
listed below, grouped by precedence, in decreasing order:

|  Operators                          |  Associativity
|-------------------------------------|------------------------------------
|  `.`Name, `[`Expr`]`, `(`Expr,*`)`  |  Left (Suffix)
|  `^`                                |  Right
|  `not`, `-`                         |  Right (Prefix)
|  `*`, `/`, `//`, `%`                |  Left
|  `+`, `-`, `++`                     |  Left
|  `==`, `!=`, `<`, `>`, `<=`, `>=`   |  Relational (Pythonic)
|  `and`                              |  Left
|  `or`                               |  Left
|  `?`Expr`:`                         |  Right
|  `$`                                |  Right

With relational associativity, both the right- and left-associative pairings
of each term are evaluated, and the entire expression is true only if all
the pairings are true. For example: `a < b < c < d` is equivalent to `(a <
b) and (b < c) and (c < d)`.


## Implementation Notes

Handling the 2D syntax is not straightforward with a conventional grammar.
To handle this, we use a PEG library that supports stateful parsing.  The
indentation of the current block is saved in the parser state, allowing
continuation lines, nested blocks, and logical line endings to be detected.

Instead of using two stages of parsing, one for the high-level syntax and
one for the lower-level, we actually use one integrated PEG grammar.  The 2D
grammar "invokes" the inline grammar's `LogLine` after identifying the
beginning of the logical line, and the inline grammar "invokes" the 2D
grammar to recognize nested blocks and the end of the logical line.

In order to collapse the two layers into one, we need to ensure that the
lower-layer parsing expressions will respect the "boundaries" defined by the
higher layer, and not read beyond them.  A simple and robust approach would
be to generate a transformed grammar.  For example, in order to recognize an
`ILE` within a `LogicalLine`, we could generate a new grammar from the
lower-level grammar, prefixing every primitive expression referenced by
`ILE` (directly or indirectly) with `!Boundary`, defining `Boundary` to
always match the following:

 - The end of a logical line.
 - The beginning of a block within a logical line.

Guarding boundaries in this manner seems potentially very costly and
involved.  Fortunately, we can define these boundaries so that they occur
only at newline characters.  There is only one parsing expression in the
low-level grammar that might match a newline (`Spacing`).  After
transformation, it will newlines only when they precede a continuation line,
not a nested block or the end of the logical line.


### Resiliency

The grammar discussed so far can be thought of as optimistic, because it
only describes how to parse valid inputs.  In order to accept arbitrary
inputs, we will have to augment the grammar to accommodate extraneous and
missing elements.

When nested blocks are distinguished from continuation lines, we need to
determine whether to treat the line as a statement.  It must match all valid
statements and *not* match any valid continuation line, but this turns out
to be simpler than the complete grammar for a statement.  It roughly boils
down to "begins with one of a small set of keywords, or a variable
definition."

`LogLine` must always succeed, generating a "missing expression" AST node if
necessary.

`LogLine` must consume the entirety of the logical line, skipping text if
necessary.

Some sub-expressions clearly imply an expectation of others.  For example,
after encountering an `if` we expect an expression and then a colon.
Instead of failing to recognize the entire `if` statement, we can generate
errors like "expected `:` after in `if EXPR: EXPR`", instead of discarding
the statement entirely.


## Future Directions

Features:

 * Allow non-indented continuation lines if they begin with a closing
   delimiter.

 * String escape `\u{X}`, where `X` is one or more hexadecimal digits.

It would be nice to be more "picky" in general to catch unintentional
errors, especially since errors do not prevent progress.  We could flag as
errors:

 * Raw tab characters in a string.
 * Block or continuation indent only one space deeper than the parent.
 * Initial line is indented.


[1] https://en.wikipedia.org/wiki/Parsing_expression_grammar
