" Continue type-only imports into their named bindings, including multiline imports.
syntax keyword typescriptImportType type contained nextgroup=nidoTypeImportBlock,typescriptDefaultImportName skipwhite skipnl
syntax region nidoTypeImportBlock matchgroup=typescriptBraces start=/{/ end=/}/ contained contains=typescriptIdentifierName,typescriptImport fold
