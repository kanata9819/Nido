" Continue type-only imports into their named bindings, including multiline imports.
syntax keyword typescriptImportType type contained nextgroup=nidoTypeImportBlock,typescriptDefaultImportName skipwhite skipnl
syntax region nidoTypeImportBlock matchgroup=typescriptBraces start=/{/ end=/}/ contained contains=typescriptIdentifierName,typescriptImport fold

" Color unclassified properties while preserving built-in member syntax.
syntax match typescriptProp contained /\K\k*!\?/ contains=@props nextgroup=@afterIdentifier skipwhite skipempty
