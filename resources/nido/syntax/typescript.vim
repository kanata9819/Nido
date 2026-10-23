" Continue type-only imports into their named bindings, including multiline imports.
syntax keyword typescriptImportType type contained nextgroup=nidoTypeImportBlock,typescriptDefaultImportName skipwhite skipnl
syntax region nidoTypeImportBlock matchgroup=typescriptBraces start=/{/ end=/}/ contained contains=typescriptIdentifierName,typescriptImport fold

" Color unclassified properties while preserving built-in member syntax.
syntax match typescriptProp contained /\K\k*!\?/ contains=@props nextgroup=@afterIdentifier skipwhite skipempty

" Native syntax groups await with async; VS Code treats only await as control flow.
syntax keyword typescriptAwait await nextgroup=@typescriptValue,typescriptUsing skipwhite
syntax cluster typescriptTopExpression add=typescriptAwait

" Matches let object-key context take priority over these contextual keywords.
syntax clear typescriptCastKeyword
syntax match typescriptCastKeyword /\<as\>/ nextgroup=typescriptConstAssertion,@typescriptType skipwhite
syntax match typescriptCastKeyword /\<satisfies\>/ nextgroup=@typescriptType skipwhite
syntax match typescriptObjectLabel contained /\k\+\_s*/ nextgroup=typescriptObjectColon,@typescriptCallImpl skipwhite skipempty
" A const assertion is a modifier, while named types after as retain type colors.
syntax keyword typescriptConstAssertion const contained nextgroup=@typescriptTypeOperator skipwhite skipempty
