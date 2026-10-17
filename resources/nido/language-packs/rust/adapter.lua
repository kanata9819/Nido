local M = {}

function M.setup()
  local cargo_home = vim.env.CARGO_HOME or vim.fs.joinpath(vim.fn.expand('~'), '.cargo')
  local cargo_bin = vim.fs.joinpath(cargo_home, 'bin')
  if vim.fn.executable('rust-analyzer') == 0 and vim.fn.isdirectory(cargo_bin) == 1 then
    vim.env.PATH = cargo_bin .. (vim.fn.has('win32') == 1 and ';' or ':') .. (vim.env.PATH or '')
  end
  local group = vim.api.nvim_create_augroup('NidoRustPack', {clear=true})
  if vim.fn.executable('rust-analyzer') == 0 then
    vim.api.nvim_create_autocmd('FileType', {group=group, pattern='rust', once=true, callback=function()
      vim.notify('Rust language support needs rust-analyzer. Run: rustup component add rust-analyzer', vim.log.levels.WARN)
    end})
    return false
  end
  vim.lsp.config('rust_analyzer', {
    cmd={'rust-analyzer'}, filetypes={'rust'},
    -- Preserve one server per workspace, including navigation into the Rust sysroot.
    root_dir=vim.fn.getcwd(),
    settings={['rust-analyzer']={check={command='check'}}},
  })
  vim.lsp.enable('rust_analyzer')
  return true
end

return M
