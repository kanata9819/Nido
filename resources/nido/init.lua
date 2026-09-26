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
local colors = {
 Normal = {fg='#d6dce2',bg='#191e23'}, NormalFloat = {fg='#d6dce2',bg='#22292f'},
 LineNr = {fg='#65717d'}, CursorLineNr = {fg='#a8cf9e'},
 Comment = {fg='#75828c',italic=true}, String = {fg='#a8cf9e'},
 Statement = {fg='#c9a6e6'}, Keyword = {fg='#c9a6e6'}, Type = {fg='#86bddd'},
 Function = {fg='#88c8dc'}, Identifier = {fg='#b9cee4'}, Number = {fg='#dbb98b'},
 Special = {fg='#dbb98b'}, Visual = {bg='#35464e'}, Search = {fg='#191e23',bg='#d6bc87'},
 Pmenu = {fg='#d6dce2',bg='#252e35'}, PmenuSel = {fg='#191e23',bg='#a8cf9e'},
 NonText = {fg='#46515c'}, EndOfBuffer = {fg='#191e23'},
}
for name, attrs in pairs(colors) do vim.api.nvim_set_hl(0, name, attrs) end

vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(event)
    local opts = { buffer = event.buf }
    vim.keymap.set('n', 'gd', vim.lsp.buf.definition, opts)
    vim.keymap.set('n', 'gr', vim.lsp.buf.references, opts)
    vim.keymap.set('n', 'K', vim.lsp.buf.hover, opts)
    local client = vim.lsp.get_client_by_id(event.data.client_id)
    if client and client:supports_method('textDocument/completion') then
      vim.lsp.completion.enable(true, client.id, event.buf, { autotrigger = true })
    end
  end,
})

-- Language servers are separate executables; use an installed Rust toolchain.
if vim.fn.executable('rust-analyzer') == 1 then
  vim.lsp.config('rust_analyzer', {
    cmd = { 'rust-analyzer' },
    filetypes = { 'rust' },
    root_markers = { 'Cargo.toml', '.git' },
    settings = { ['rust-analyzer'] = { check = { command = 'check' } } },
  })
  vim.lsp.enable('rust_analyzer')
end
