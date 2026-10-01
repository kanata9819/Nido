-- Nido owns this configuration; personal Neovim config is not loaded.
vim.g.nido = true
vim.opt.shortmess:append('IWFSs')
vim.o.hlsearch = true
vim.o.incsearch = true
for _, key in ipairs({'*', '#', 'n', 'N', 'g*', 'g#'}) do
  vim.keymap.set('n', key, function()
    vim.cmd.normal({args={(vim.v.count > 0 and tostring(vim.v.count) or '') .. key}, bang=true, mods={silent=true}})
    vim.api.nvim_exec_autocmds('User', {pattern='NidoSearch'})
  end, {silent=true})
end
vim.keymap.set('n', '<Esc>', function()
  vim.cmd.nohlsearch()
  vim.api.nvim_exec_autocmds('User', {pattern='NidoSearch'})
end, {silent=true})
vim.o.termguicolors = true
vim.o.number = true
vim.o.relativenumber = false
-- Buffer switches can restore cached window options from before a settings change.
vim.api.nvim_create_autocmd({ 'BufWinEnter', 'WinEnter' }, {
  callback = function()
    if vim.bo.buftype == '' and vim.api.nvim_win_get_config(0).relative == '' then
      vim.wo.relativenumber = vim.go.relativenumber
    end
  end,
})
vim.o.showmode = false
vim.o.ruler = false
vim.o.showcmd = false
-- Normal-mode Ctrl+C should cancel without Neovim's terminal quit hint.
vim.keymap.set('n', '<C-c>', '<Esc>', { silent = true })
-- Keep undo/redo progress out of the command line while retaining errors.
for _, key in ipairs({'u', 'U', '<C-r>', 'g-', 'g+'}) do
  vim.keymap.set('n', key, function()
    local keys = vim.api.nvim_replace_termcodes(key, true, false, true)
    vim.cmd.normal({args={vim.v.count1 .. keys}, bang=true, mods={silent=true}})
  end, { silent = true })
end
vim.o.laststatus = 0
vim.keymap.set('n', '<C-z>', 'u', {remap=true, silent=true})
vim.keymap.set('x', '<C-z>', '<Esc>u', {remap=true, silent=true})
vim.keymap.set('i', '<C-z>', '<C-o>u', {remap=true, silent=true})
vim.o.showtabline = 0
vim.o.mouse = 'a'
vim.o.hidden = true
vim.o.expandtab = true
vim.o.shiftwidth = 2
vim.o.tabstop = 2
vim.o.ignorecase = true
vim.o.smartcase = true
vim.o.scrolloff = 5
vim.o.signcolumn = 'yes:2'
vim.o.fillchars = 'eob: '
vim.cmd('syntax enable')
vim.cmd('filetype plugin indent on')
vim.opt.completeopt = { 'menu', 'menuone', 'noselect', 'noinsert', 'fuzzy' }
vim.o.pumheight = 10
vim.keymap.set('i', '<Tab>', function()
  if vim.fn.pumvisible() == 1 then
    local selected = math.max(0, vim.fn.complete_info({'selected'}).selected)
    return '<Cmd>lua vim.api.nvim_select_popupmenu_item(' .. selected .. ', true, true, {})<CR>'
  end
  return '<Tab>'
end, { expr = true, silent = true })
local completion_scheduled
local function completion_refresh(pending)
  if vim.g.nido_channel then
    vim.rpcnotify(vim.g.nido_channel, 'nido:completion_refresh', pending, vim.fn.pumvisible() == 1)
  end
end
vim.api.nvim_create_autocmd('TextChangedI', {
  callback = function(event)
    local buffer = event.buf
    local tick = vim.api.nvim_buf_get_changedtick(buffer)
    if not vim.api.nvim_get_current_line():sub(1, vim.fn.col('.') - 1):match('[%w_\128-\255]$') then return end
    if #vim.lsp.get_clients({bufnr=buffer, method='textDocument/completion'}) == 0 then return end
    local scheduled = {}
    completion_scheduled = scheduled
    -- Backspace ends native complete() before this new request; keep the GUI card mounted.
    completion_refresh(true)
    vim.defer_fn(function()
      if completion_scheduled ~= scheduled then return end
      completion_scheduled = nil
      if vim.api.nvim_buf_is_valid(buffer) and vim.api.nvim_get_current_buf() == buffer
          and vim.api.nvim_buf_get_changedtick(buffer) == tick and vim.fn.mode() == 'i'
          and vim.fn.pumvisible() == 0
          and #vim.lsp.get_clients({bufnr=buffer, method='textDocument/completion'}) > 0 then
        -- Ordinary text uses an invoked request: servers may reject letters as trigger characters.
        vim.lsp.completion.get()
      else
        completion_refresh(false)
      end
    end, 30)
  end,
})
vim.api.nvim_create_autocmd('LspRequest', {
  callback = function(event)
    if event.buf ~= vim.api.nvim_get_current_buf()
        or event.data.request.method ~= 'textDocument/completion' then return end
    if event.data.request.type == 'pending' then
      completion_refresh(true)
    else
      vim.schedule(function()
        if completion_scheduled then return end
        for _, client in ipairs(vim.lsp.get_clients({bufnr=0, method='textDocument/completion'})) do
          for _, request in pairs(client.requests) do
            if request.bufnr == event.buf and request.method == 'textDocument/completion'
                and request.type == 'pending' then return end
          end
        end
        completion_refresh(false)
      end)
    end
  end,
})
vim.api.nvim_create_autocmd('LspDetach', {
  callback = function(event)
    vim.schedule(function()
      if event.buf == vim.api.nvim_get_current_buf()
          and #vim.lsp.get_clients({bufnr=event.buf, method='textDocument/completion'}) == 0 then
        completion_scheduled = nil
        completion_refresh(false)
      end
    end)
  end,
})
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
vim.api.nvim_set_hl(0, 'Search', {fg='#ffe5a3', bg='#514020'})
vim.api.nvim_set_hl(0, 'CurSearch', {fg='#152219', bg='#a8cf9e', bold=true})
vim.api.nvim_set_hl(0, 'IncSearch', {link='CurSearch'})
require('nido_indent')
require('nido_editorconfig')
require('nido_brackets')
require('nido_git_signs')
-- Darken surfaces without changing Azami's token colors.
for _, name in ipairs({'Normal', 'NormalNC', 'LineNr', 'CursorLineNr', 'SignColumn', 'EndOfBuffer'}) do
  local attrs = vim.api.nvim_get_hl(0, {name=name, link=false})
  attrs.bg = '#121212'
  if name == 'EndOfBuffer' then attrs.fg = '#121212' end
  vim.api.nvim_set_hl(0, name, attrs)
end
-- Native Rust syntax and LSP use these groups without a Rust Tree-sitter parser.
vim.api.nvim_set_hl(0, 'rustKeyword', {link='@keyword'})
vim.api.nvim_set_hl(0, 'rustStructure', {link='@keyword'})
vim.api.nvim_set_hl(0, '@lsp.type.namespace.rust', {link='@module'})
vim.api.nvim_set_hl(0, '@lsp.type.typeAlias.rust', {link='@type'})
vim.api.nvim_set_hl(0, '@lsp.type.const.rust', {link='@constant'})
vim.o.winborder = 'rounded'
vim.api.nvim_set_hl(0, 'NormalFloat', {fg='#d4d4d4', bg='#1b1e21'})
vim.api.nvim_set_hl(0, 'FloatBorder', {fg='#65717d', bg='#1b1e21'})
vim.api.nvim_set_hl(0, 'FloatTitle', {fg='#a8cf9e', bg='#1b1e21', bold=true})
local show_type_information = require('nido_hover').show
local runnables = require('nido_runnables')
vim.keymap.set('n', 'gR', function() runnables.execute(false) end)
vim.keymap.set('n', 'gD', function() runnables.execute(true) end)
vim.keymap.set('n', 'zz', function() require('nido_scroll').center(vim.v.count) end)
for _, key in ipairs({'<C-d>', '<C-f>', '<PageDown>'}) do
  vim.keymap.set('n', key, function() require('nido_scroll').page(key, vim.v.count) end)
end
-- Always override the built-in K help lookup, including files without an LSP.
for _, key in ipairs({ 'K', '<C-k>' }) do
  vim.keymap.set('n', key, show_type_information)
end
vim.api.nvim_create_autocmd('LspAttach', {
  callback = function(event)
    local opts = { buffer = event.buf }
    vim.keymap.set('n', 'gd', vim.lsp.buf.definition, opts)
    vim.keymap.set('n', 'gr', function() require('nido_references').find() end, opts)
    vim.keymap.set('n', '<S-F12>', function() require('nido_references').find() end, opts)
    for _, key in ipairs({ 'K', '<C-k>' }) do
      vim.keymap.set('n', key, show_type_information, opts)
    end
    vim.keymap.set('n', '<F12>', vim.lsp.buf.definition, opts)
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
      vim.lsp.completion.enable(true, client.id, event.buf, {
        autotrigger = true,
        convert = function(item)
          local prefix = vim.api.nvim_get_current_line():sub(1, vim.fn.col('.') - 1):match('[%w_\128-\255]+$') or ''
          if prefix ~= '' then
            local score = vim.fn.matchfuzzypos({item.filterText or item.label}, prefix)[3][1] or 0
            -- Preserve the server's contextual order when matching scores are equal.
            item.sortText = string.format('%09d:', 999999999 - score) .. (item.sortText or item.label)
          end
          return {}
        end,
      })
      vim.keymap.set('i', '<C-Space>', vim.lsp.completion.get, opts)
    end
  end,
})

-- Prefer independently updated project/external language servers, with a bundled fallback.
if vim.env.NIDO_NODE and vim.env.NIDO_LANGUAGES then
  local ok, err = pcall(function() require('nido_typescript').setup() end)
  if not ok then vim.schedule(function() vim.notify(tostring(err), vim.log.levels.ERROR) end) end
end

-- Rust uses the installed toolchain matching the workspace.
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
