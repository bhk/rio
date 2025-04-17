# Sources here are ordinary JavaScript and include embedded unit tests -- to
# load them is to test them.  Node and make are external dependencies.

export NODE_PATH = .

example: ; node run.js example.rio

desugar: ; node desugar.js

host:	; node host.js

