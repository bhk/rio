#--------------------------------
# Minion Classes for JS Projects
#--------------------------------

QUIET = #@

# Some supporting files are located in this directory
_classes.mk_dir := $(dir $(lastword $(MAKEFILE_LIST)))
peelDir = $(dir $(patsubst %/,%,$1))

# External Dependencies
esbuild ?= $(call _checkPath,esbuild)
wat2wasm ?= $(call _checkPath,wat2wasm)
terser ?= $(call _checkPath,terser)
node ?= $(call _checkPath,node)

_checkPath = $(if $(shell which $1),$1,$(error $$($1) undefined))

# Demo(SOURCE): Shorthand that builds JSToHTML(Bundle(SOURCE))
#
Demo.inherit = Phony
Demo.in = JSToHTML(Bundle($(_arg1)))


# ODemo(SOURCE): Shorthand for Open(Demo(SOURCE))
#
ODemo.inherit = Demo
ODemo.in = Open({inherit})


# HTMLIndex(FILES) : Create HTML index of FILES
#
HTMLIndex.inherit = Write
HTMLIndex.outExt = .html
HTMLIndex.oo = $(_args)
HTMLIndex.links = $(call get,out,{ooIDs})
define HTMLIndex.data
  <!DOCTYPE html>
  <style>
    a $([[)
      display: block; font: 32px sans-serif; margin: 32px;
      text-decoration: none;
    $(]])
  </style>
  $(foreach p,$(foreach i,{links},$(call _relpath,{@},$i)),
    <a href="$p">$(notdir $(basename $p))</a>)
endef

# $(call _relpath,TO,FROM)
_relpath = $(if $(filter /%,$2),$2,$(if $(filter ..,$(subst /, ,$1)),$(error _relpath: '..' in $1),$(or $(foreach w,$(filter %/%,$(word 1,$(subst /,/% ,$1))),$(call _relpath,$(patsubst $w,%,$1),$(if $(filter $w,$2),$(patsubst $w,%,$2),../$2))),$2)))


# TestJS(TEST) : Execute the Javascript file TEST using node.
#
# We use `--experimental-loader` to track implied dependencies.
#
TestJS.inherit = Builder
TestJS.command = {env} $(node) {depsFlags} {scriptArgs} && touch {@}
# TestJS_MT (analogous to gcc -MT) is used by node-M.js
TestJS.env = NODE_NO_WARNINGS=1 TestJS_MT={@}
# Note the "./" preceding node-M.js...
TestJS.depsFlags = --experimental-loader ./$(_classes.mk_dir)node-M.js
TestJS.rule = -include {@}.d$(\n){inherit}
TestJS.scriptArgs = {<}


# TestJSB(TEST) : Execute JavaScript that assumes the browser environment.
#     This loads mockdom.js before the test file.
#
TestJSB.inherit = TestJS
TestJSB.scriptArgs = -e 'process.argv.slice(1).forEach(m=>import(m))' {mockdom} ./{<}
TestJSB.mockdom := $(call peelDir,./$(_classes.mk_dir))mockdom.js


# Open(FILE) : Launch a browser/viewer on FILE
#
Open.inherit = Phony
Open.command = open -a "Google Chrome" {<}
Open.in = $(_args)


# Bundle(SOURCE,[min:1])
#
#   Bundle JavaScript file SOURCE with its dependencies.  Minify if `min` is
#   given.
#
Bundle.inherit ?= ESBuild


# _Bundle(...) : Base class for Bundle() implementations.
#
_Bundle.inherit = Builder
# If {min} is non-empty, minify while bundling.
_Bundle.min = $(call _namedArgs,min)

# JavaScript expression to generate a GCC-style `-M -MP` dependency file from an ESBuild metafile
jsonToMMP = Object.entries(require("$1").outputs).map(([k,v])=>Object.keys(v.inputs).map(i=>k+": "+i+"\n"+i+":").join("\n"))[0]
# ... alternate
jsonToMMPx = Object.entries(require("$1").outputs).map(([k,v])=>((i=>[...i,k].join(":\n")+": "+i.join(" ")+"\n")(Object.keys(v.inputs))))[0]
# ... without -MP
jsonToM = (([k,v])=>k+": "+Object.keys(v.inputs).join(" "))(Object.entries(require("$1").outputs)[0])

# ESBuild(...) : See _Bundle
#
ESBuild.inherit = _Bundle
ESBuild.command = {bundleCmd}$(\n)@{depsCmd}
ESBuild.bundleCmd = $(QUIET){exe} --outfile={@} {<} --bundle $(if {min},--minify) --metafile={@}.json --color=false --log-level=warning --loader:.wasm=binary
ESBuild.depsCmd = $(node) -p '$(call jsonToMMP,./{@}.json)' > {depsFile}
ESBuild.rule = -include {depsFile}$(\n){inherit}
ESBuild.exe = $(esbuild)
ESBuild.depsFile = {@}.d
ESBuild.vvValue = $(call _vvEnc,{bundleCmd},{@})


# JSToHTML(JSFILE) : Create an HTML file that runs a JS module JSFILE.
#
JSToHTML.inherit = Builder
JSToHTML.outExt = %.html
JSToHTML.command = $(QUIET)$(node) {up^} {<} -o {@}
JSToHTML.up = $(_classes.mk_dir)js-to-html.js


# JSMin(JSFILE) : Minify JavaScript file JSFILE.
#
JSMin.inherit = Builder
JSMin.command = $(terser) --compress "ecma=2015,toplevel,unsafe_arrows" --mangle toplevel --define globalThis.TEST=false -o {@} {<}


# Wasm(WAT): Convert WAT to WASM.
#
Wasm.inherit = Builder
Wasm.outExt = .wasm
Wasm.command = $(wat2wasm) --output={@} {<}

