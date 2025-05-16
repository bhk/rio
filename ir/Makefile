# Geting Started
#
#   Install dependencies with `npm install` (in this directory).  Node
#   and make are external dependencies.
#
#   The JS sources here are ES modules, and should be directly usable by a
#   browser or Node.  To this end...
#
#    - Imports must use relative paths beginning with "./" or "../" to
#      work in browsers.
#
#    - We add `"type":"module"` to package.json so Node will recognize ".js"
#      files as ES6 modules.
#
#    - We remap `./test.js` to `./no-test.js` when bulding bundles for the
#      browser.  This allows us to include off-target tests for non-exported
#      functions inside any module and strip them out for deployment.
#
#   X_q.js => an automated test for X.js.
#     `make TestJS(X_q.js)` to run it, or `make test` to run them all.
#     To debug use `node --inspect-brk` and chrome://inspect.
#
#   X_demo.js => a visual test for a UI component X.js.
#     `make ODemo(X_demo.js)` to view one and inspect in a browser.
#     `make demo` to view a page with links to all of them.
#
# This Makefile is Minion-based.  See github.com/bhk/minion for complete
# documentation, but `make help` and `make help GOAL` will get you far.
# Custom Minion classes are defined in build/classes.mk; look there for
# descriptions of TestJS, JSToHTML, Demo, etc.
#

Alias(default).in = Alias(test)
Alias(test).in = TestJS@tests TestJSB@demos
Alias(demo).in = Open(HTMLIndex(JSToHTML@Bundle@demos))
Alias(server).command = node server.js /

tests = @*_q.js
demos = @*_demo.js

# Set {oo} to use TestJS() to validate JS files before bundling them
Bundle.inherit = ESBuild
Bundle.oo = TestJSB({<}) \
   $(patsubst %,TestJS(%),\
      $(filter $(tests),$(patsubst %_demo.js,%_q.js,{<})))


esbuild = ./node_modules/.bin/esbuild
node = node
include build/classes.mk

# Ordering of tests (hard-code at least the most important constraints)

TestJS.oo = TestJS(e_q.js)
TestJS(i_q.js).oo =
TestJS(e_q.js).oo = TestJS(i_q.js)

include build/minion.mk
