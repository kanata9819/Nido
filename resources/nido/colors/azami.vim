hi clear
if exists('syntax_on')
  syntax reset
endif

set background=dark

lua << EOF
local ok, vscode = pcall(require, 'vscode')
if not ok then
  return
end

vscode.setup({
  style = 'dark',
  transparent = false,
  italic_comments = false,
  italic_keywords = false,
  italic_inlayhints = false,
  underline_links = true,
  disable_nvimtree_bg = true,
  terminal_colors = true,
  color_overrides = {
    vscBack = '#1E1E1E',
    vscTabCurrent = '#1E1E1E',
    vscPopupBack = '#252526',
    vscLeftDark = '#181818',
    vscLeftMid = '#2D2D30',
    vscSelection = '#264F78',
    vscLineNumber = '#858585',
    vscCursorDarkDark = '#2A2D2E',
    vscSplitDark = '#2B2B2B',
    vscPopupHighlightBlue = '#094771',
    vscPopupHighlightGray = '#2A2D2E',
    vscFoldBackground = '#202D39',
    vscContext = '#404040',
    vscContextCurrent = '#707070',
  },
  group_overrides = {
    NormalFloat = { bg = '#252526' },
    FloatBorder = { fg = '#454545', bg = '#252526' },
    Pmenu = { fg = '#CCCCCC', bg = '#252526' },
    PmenuSel = { fg = '#FFFFFF', bg = '#094771' },
    StatusLine = { fg = '#CCCCCC', bg = '#2D2D30' },
    StatusLineNC = { fg = '#8C8C8C', bg = '#252526' },
    WinSeparator = { fg = '#2B2B2B', bg = '#1E1E1E' },
    CursorLineNr = { fg = '#C6C6C6', bg = '#1E1E1E', bold = false },
    Visual = { bg = '#264F78' },
    Search = { fg = 'NONE', bg = '#613315' },
    IncSearch = { fg = 'NONE', bg = '#515C6A' },
    LineNr = { fg = '#858585', bg = '#1E1E1E' },
    Folded = { fg = '#CCCCCC', bg = '#202D39' },
  },
})

vscode.load('dark')

local c = require('vscode.colors').get_colors()
local hl = vim.api.nvim_set_hl

hl(0, 'Normal', { fg = c.vscFront, bg = '#1E1E1E' })
hl(0, 'NormalNC', { fg = c.vscFront, bg = '#1E1E1E' })
hl(0, 'EndOfBuffer', { fg = '#1E1E1E', bg = '#1E1E1E' })
hl(0, 'SignColumn', { fg = 'NONE', bg = '#1E1E1E' })
hl(0, '@lsp.type.keyword', { fg = c.vscBlue, bg = 'NONE' })
hl(0, '@keyword', { fg = c.vscBlue, bg = 'NONE' })
hl(0, '@keyword.import', { fg = c.vscPink, bg = 'NONE' })
hl(0, '@keyword.function', { fg = c.vscBlue, bg = 'NONE' })
hl(0, '@keyword.return', { fg = c.vscPink, bg = 'NONE' })
hl(0, '@module', { fg = c.vscBlueGreen, bg = 'NONE' })
hl(0, '@azami_visibility', { fg = c.vscBlue, bg = 'NONE' })
hl(0, '@azami_self', { fg = c.vscBlue, bg = 'NONE' })
hl(0, '@type', { fg = c.vscBlueGreen, bg = 'NONE' })
hl(0, '@type.builtin', { fg = c.vscBlueGreen, bg = 'NONE' })
hl(0, '@function.method', { fg = c.vscYellow, bg = 'NONE' })
-- Match the parameter override in the reference VS Code theme.
hl(0, '@variable.parameter', { fg = '#FFB300', bg = 'NONE' })
hl(0, '@lsp.type.parameter', { fg = '#FFB300', bg = 'NONE' })
hl(0, '@constructor', { fg = c.vscAccentBlue, bg = 'NONE' })
hl(0, '@lsp.type.enum', { fg = c.vscBlueGreen, bg = 'NONE' })
hl(0, '@lsp.type.enumMember', { fg = c.vscAccentBlue, bg = 'NONE' })
hl(0, 'rustEnum', { fg = c.vscBlueGreen, bg = 'NONE' })
hl(0, 'rustEnumVariant', { fg = c.vscAccentBlue, bg = 'NONE' })
hl(0, 'rustConstant', { fg = c.vscAccentBlue, bg = 'NONE' })
hl(0, 'rustStorage', { fg = c.vscBlue, bg = 'NONE' })
hl(0, 'rustTrait', { fg = c.vscBlueGreen, bg = 'NONE' })
hl(0, 'rustSelf', { fg = c.vscBlue, bg = 'NONE' })
hl(0, 'rustType', { fg = c.vscBlue, bg = 'NONE' })
hl(0, 'rustTypedef', { fg = c.vscBlue, bg = 'NONE' })
hl(0, 'rustModPath', { fg = c.vscBlueGreen, bg = 'NONE' })
hl(0, 'rustModPathSep', { fg = c.vscFront, bg = 'NONE' })
hl(0, 'rustFuncName', { fg = c.vscYellow, bg = 'NONE' })
hl(0, 'rustMacro', { fg = c.vscYellow, bg = 'NONE' })
hl(0, 'rustDeriveTrait', { fg = c.vscBlueGreen, bg = 'NONE' })
hl(0, '@function.macro', { fg = c.vscYellow, bg = 'NONE' })
hl(0, '@constant.macro', { fg = c.vscBlueGreen, bg = 'NONE' })
hl(0, '@variable.builtin', { fg = c.vscBlue, bg = 'NONE' })
hl(0, '@label', { fg = c.vscBlue, bg = 'NONE' })
hl(0, '@lsp.mod.deprecated', { strikethrough = true })
-- Dark Modern token categories, including Vim's legacy syntax group names.
-- Keep parameter names aligned with the user's VS Code override (#FFB300).
for color, groups in pairs({
  [c.vscPink] = {
    'typescriptTry', 'typescriptExceptions', 'typescriptBranch', 'typescriptCase', 'typescriptDefault',
    'typescriptConditional', 'typescriptConditionalElse', 'typescriptRepeat', 'typescriptStatementKeyword',
    'typescriptImport', 'typescriptExport', 'typescriptAsyncFunc',
    '@keyword.conditional', '@keyword.repeat', '@keyword.exception', '@lsp.typemod.keyword.controlFlow',
  },
  [c.vscBlue] = {
    'typescriptVariable', 'typescriptFuncKeyword', 'typescriptAsyncFuncKeyword', 'typescriptObjectAsyncKeyword',
    'typescriptClassKeyword', 'typescriptInterfaceKeyword', 'typescriptAliasKeyword', 'typescriptEnumKeyword',
    'typescriptPredefinedType', 'typescriptAccessibilityModifier', 'typescriptReadonlyModifier',
    'typescriptClassStatic', 'typescriptAbstract', 'typescriptAmbientDeclaration', 'typescriptCastKeyword',
    'typescriptKeywordOp', 'typescriptImportType', 'javaScriptFunction', 'javaScriptNull', 'javaScriptIdentifier',
    '@type.builtin.typescript', '@type.builtin.javascript',
  },
  [c.vscFront] = {
    'typescriptBinaryOp', 'typescriptAssign', 'typescriptUnaryOp', 'typescriptTernaryOp',
    'typescriptEndColons', 'typescriptFuncComma', 'typescriptBraces', 'typescriptParens',
    'typescriptBlock', 'typescriptClassBlock', 'typescriptObjectLiteral', 'typescriptArray',
    'typescriptFuncTypeArrow', 'javaScriptBraces',
  },
  [c.vscLightBlue] = {'typescriptVariableDeclaration', 'typescriptLabel', 'typescriptCall', 'typescriptDestructureVariable', 'typescriptTypeBlock', 'typescriptDefaultImportName'},
  [c.vscBlueGreen] = {'typescriptTypeReference', 'typescriptInterfaceName', 'typescriptClassName', 'typescriptAliasDeclaration', 'nidoTypeImportBlock'},
  [c.vscYellow] = {'typescriptFuncName', 'typescriptMember', '@lsp.type.function', '@lsp.type.method'},
  ['#FFB300'] = {'typescriptParamImpl', 'typescriptArrowFuncArg', 'typescriptDocParamName'},
}) do
  for _, group in ipairs(groups) do hl(0, group, {fg=color}) end
end
hl(0, 'NeoTreeNormal', { fg = c.vscFront, bg = '#181818' })
hl(0, 'NeoTreeNormalNC', { fg = c.vscFront, bg = '#181818' })
hl(0, 'NeoTreeEndOfBuffer', { fg = '#181818', bg = '#181818' })
hl(0, 'SnacksIndent', { fg = '#404040' })
hl(0, 'SnacksIndentScope', { fg = '#707070' })
EOF

let g:colors_name = 'azami'
