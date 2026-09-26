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
-- Bundle only Azami and its theme dependency; personal plugins stay isolated.
vim.opt.runtimepath:append(vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':h'))
vim.cmd('colorscheme azami')
-- Darken surfaces without changing Azami's token colors.
for _, name in ipairs({'Normal', 'NormalNC', 'LineNr', 'CursorLineNr', 'SignColumn', 'EndOfBuffer'}) do
  local attrs = vim.api.nvim_get_hl(0, {name=name, link=false})
  attrs.bg = '#141414'
  if name == 'EndOfBuffer' then attrs.fg = '#141414' end
  vim.api.nvim_set_hl(0, name, attrs)
end
-- Native Rust syntax and LSP use these groups without a Rust Tree-sitter parser.
vim.api.nvim_set_hl(0, 'rustKeyword', {link='@keyword'})
vim.api.nvim_set_hl(0, 'rustStructure', {link='@keyword'})
vim.api.nvim_set_hl(0, '@lsp.type.namespace.rust', {link='@module'})
vim.api.nvim_set_hl(0, '@lsp.type.macro.rust', {link='@function.macro'})
vim.api.nvim_set_hl(0, '@lsp.type.typeAlias.rust', {link='@type'})
vim.api.nvim_set_hl(0, '@lsp.type.const.rust', {link='@constant'})
vim.o.winborder = 'rounded'
vim.api.nvim_set_hl(0, 'NormalFloat', {fg='#d4d4d4', bg='#1b1e21'})
vim.api.nvim_set_hl(0, 'FloatBorder', {fg='#65717d', bg='#1b1e21'})
vim.api.nvim_set_hl(0, 'FloatTitle', {fg='#a8cf9e', bg='#1b1e21', bold=true})
local function preview_options(title)
  return {
    border = 'rounded', title = ' ' .. title .. ' ', title_pos = 'left',
    max_width = math.max(20, math.min(88, math.floor(vim.o.columns * 0.7))),
    max_height = math.max(4, math.min(20, math.floor(vim.o.lines * 0.45))),
  }
end
vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(event)
    local opts = { buffer = event.buf }
    vim.keymap.set('n', 'gd', vim.lsp.buf.definition, opts)
    vim.keymap.set('n', 'gr', vim.lsp.buf.references, opts)
    for _, key in ipairs({'K', '<C-k>'}) do
      vim.keymap.set('n', key, function()
        vim.lsp.buf.hover(preview_options('Type information · K to focus'))
      end, opts)
    end
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
    -- Each Nido session owns one workspace, including navigation into dependencies.
    -- Discovering a root per buffer would start another server for Rust's sysroot.
    root_dir = vim.fn.getcwd(),
    settings = { ['rust-analyzer'] = { check = { command = 'check' } } },
  })
  vim.lsp.enable('rust_analyzer')
else
  vim.api.nvim_create_autocmd('FileType', { pattern = 'rust', once = true, callback = function()
    vim.notify('Rust language support needs rust-analyzer. Run: rustup component add rust-analyzer', vim.log.levels.WARN)
  end })
end
