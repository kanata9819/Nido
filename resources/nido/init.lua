-- Nido owns this configuration; personal Neovim config is not loaded.
vim.g.nido = true
vim.opt.shortmess:append('I')
vim.o.termguicolors = true
vim.o.number = true
vim.o.relativenumber = false
vim.o.showmode = false
vim.o.laststatus = 0
vim.o.showtabline = 0
vim.o.mouse = ''
vim.o.hidden = true
vim.o.expandtab = true
vim.o.shiftwidth = 2
vim.o.tabstop = 2
vim.o.ignorecase = true
vim.o.smartcase = true
vim.o.scrolloff = 5
vim.o.signcolumn = 'yes'
vim.o.fillchars = 'eob: '
vim.cmd('syntax enable')
vim.cmd('filetype plugin indent on')
vim.opt.completeopt = { 'menu', 'menuone', 'noselect' }
vim.diagnostic.config({
  virtual_text = { spacing = 2, prefix = '●' },
  signs = { text = { [1] = 'E', [2] = 'W', [3] = 'I', [4] = 'H' } },
  underline = true,
  severity_sort = true,
  update_in_insert = false,
  float = { border = 'rounded', source = true },
})
local colors = {
 Normal = {fg='#d6dce2',bg='#191e23'}, NormalFloat = {fg='#d6dce2',bg='#22292f'},
 LineNr = {fg='#65717d'}, CursorLineNr = {fg='#a8cf9e'},
 -- Dark+ style token colors, with Nido's existing editor background.
 Comment = {fg='#6a9955'}, SpecialComment = {link='Comment'},
 String = {fg='#ce9178'}, Character = {link='String'},
 Statement = {fg='#c586c0'}, Keyword = {fg='#569cd6'}, Type = {fg='#4ec9b0'},
 StorageClass = {link='Keyword'}, Structure = {link='Keyword'},
 Function = {fg='#dcdcaa'}, Identifier = {fg='#9cdcfe'}, Number = {fg='#b5cea8'},
 Float = {link='Number'}, Boolean = {link='Keyword'}, Constant = {fg='#4fc1ff'},
 Operator = {fg='#d4d4d4'}, Delimiter = {fg='#d4d4d4'},
 PreProc = {fg='#c586c0'}, Macro = {link='Function'},
 Special = {fg='#d7ba7d'}, Visual = {bg='#35464e'}, Search = {fg='#191e23',bg='#d6bc87'},
 rustModPath = {fg='#d4d4d4'}, rustSelf = {link='Keyword'},
 rustAssert = {link='Function'}, rustPanic = {link='Function'},
 Pmenu = {fg='#d6dce2',bg='#252e35'}, PmenuSel = {fg='#191e23',bg='#a8cf9e'},
 NonText = {fg='#46515c'}, EndOfBuffer = {fg='#191e23'},
 DiagnosticError = {fg='#ee8790'}, DiagnosticWarn = {fg='#dbb98b'},
 DiagnosticInfo = {fg='#86bddd'}, DiagnosticHint = {fg='#a8cf9e'},
 DiagnosticUnderlineError = {undercurl=true,sp='#ee8790'},
 DiagnosticUnderlineWarn = {undercurl=true,sp='#dbb98b'},
 ['@lsp.type.function.rust'] = {link='Function'},
 ['@lsp.type.method.rust'] = {link='Function'},
 ['@lsp.type.struct.rust'] = {link='Type'},
 ['@lsp.type.enum.rust'] = {link='Type'},
 ['@lsp.type.interface.rust'] = {link='Type'},
 ['@lsp.type.typeParameter.rust'] = {link='Type'},
 ['@lsp.type.macro.rust'] = {link='Function'},
 ['@lsp.type.parameter.rust'] = {link='Identifier'},
 ['@lsp.type.variable.rust'] = {link='Identifier'},
 ['@lsp.type.enumMember.rust'] = {link='Constant'},
 ['@lsp.type.property.rust'] = {link='Identifier'},
 ['@lsp.type.namespace.rust'] = {fg='#d4d4d4'},
}
for name, attrs in pairs(colors) do vim.api.nvim_set_hl(0, name, attrs) end

vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(event)
    local opts = { buffer = event.buf }
    vim.keymap.set('n', 'gd', vim.lsp.buf.definition, opts)
    vim.keymap.set('n', 'gr', vim.lsp.buf.references, opts)
    vim.keymap.set('n', 'K', vim.lsp.buf.hover, opts)
    vim.keymap.set('n', '<F12>', vim.lsp.buf.definition, opts)
    vim.keymap.set('n', '<S-F12>', vim.lsp.buf.references, opts)
    vim.keymap.set('n', 'gI', vim.lsp.buf.implementation, opts)
    vim.keymap.set('n', 'gy', vim.lsp.buf.type_definition, opts)
    vim.keymap.set('n', '<F2>', vim.lsp.buf.rename, opts)
    vim.keymap.set('n', 'gra', vim.lsp.buf.code_action, opts)
    vim.keymap.set('n', 'g=', function() vim.lsp.buf.format({ async = true }) end, opts)
    vim.keymap.set('n', 'gl', vim.diagnostic.open_float, opts)
    vim.keymap.set('n', ']d', function() vim.diagnostic.jump({ count = 1, float = true }) end, opts)
    vim.keymap.set('n', '[d', function() vim.diagnostic.jump({ count = -1, float = true }) end, opts)
    local client = vim.lsp.get_client_by_id(event.data.client_id)
    if client and client:supports_method('textDocument/completion') then
      vim.lsp.completion.enable(true, client.id, event.buf, { autotrigger = true })
      vim.keymap.set('i', '<C-Space>', vim.lsp.completion.get, opts)
    end
  end,
})

-- Language servers are separate executables; use an installed Rust toolchain.
local cargo_home = vim.env.CARGO_HOME or vim.fs.joinpath(vim.fn.expand('~'), '.cargo')
local cargo_bin = vim.fs.joinpath(cargo_home, 'bin')
if vim.fn.executable('rust-analyzer') == 0 and vim.fn.isdirectory(cargo_bin) == 1 then
  vim.env.PATH = cargo_bin .. (vim.fn.has('win32') == 1 and ';' or ':') .. (vim.env.PATH or '')
end
if vim.fn.executable('rust-analyzer') == 1 then
  vim.lsp.config('rust_analyzer', {
    cmd = { 'rust-analyzer' },
    filetypes = { 'rust' },
    root_markers = { 'Cargo.toml', '.git' },
    settings = { ['rust-analyzer'] = { check = { command = 'check' } } },
  })
  vim.lsp.enable('rust_analyzer')
else
  vim.api.nvim_create_autocmd('FileType', { pattern = 'rust', once = true, callback = function()
    vim.notify('Rust language support needs rust-analyzer. Run: rustup component add rust-analyzer', vim.log.levels.WARN)
  end })
end
