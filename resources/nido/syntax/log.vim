" Independent, single-line matches keep large application logs cheap to scroll.
if exists('b:current_syntax')
  finish
endif

syntax case ignore
syntax match nidoLogNumber display /\<\%(0x[0-9a-f]\+\|\d\+\%(\.\d\+\)\?\%([eE][+-]\?\d\+\)\?\)\>/
syntax keyword nidoLogBoolean true false null nil none
syntax keyword nidoLogTrace trace verbose
syntax keyword nidoLogDebug debug
syntax keyword nidoLogInfo info information notice
syntax keyword nidoLogWarning warn warning
syntax keyword nidoLogError error errors err fatal panic critical crit alert emergency emerg severe failed failure
syntax match nidoLogTimestamp display /\<\d\{4}-\d\d-\d\d\%([Tt ]\d\d:\d\d:\d\d\%([.,]\d\+\)\?\%([Zz]\|[+-]\d\d:\?\d\d\)\?\)\?/
syntax match nidoLogTimestamp display /\<\d\d:\d\d:\d\d\%([.,]\d\+\)\?\%([Zz]\|[+-]\d\d:\?\d\d\)\?/
syntax match nidoLogString display /"\%([^"\\]\|\\.\)*"/
syntax match nidoLogString display /'\%([^'\\]\|\\.\)*'/
syntax sync minlines=1 maxlines=1

highlight default link nidoLogNumber Number
highlight default link nidoLogBoolean Boolean
highlight default link nidoLogTrace Comment
highlight default link nidoLogDebug DiagnosticInfo
highlight default link nidoLogInfo Number
highlight default link nidoLogWarning DiagnosticWarn
highlight default link nidoLogError DiagnosticError
highlight default link nidoLogTimestamp Comment
highlight default link nidoLogString String

let b:current_syntax = 'log'
