local requests, replies, serial, closed = {}, {}, 0, false
vim.g.nido_completion_test_requests = requests
vim.g.nido_completion_test_replies = replies
vim.lsp.start({name='nido-completion-test',cmd=function(dispatchers)
  return {
    request=function(method, params, callback, notify_reply)
      serial = serial + 1
      local id, result, delay, prefix = serial, nil, 0, nil
      if method == 'initialize' then
        result = {capabilities={textDocumentSync=1,completionProvider={triggerCharacters={'.'}}}}
      elseif method == 'textDocument/completion' then
        prefix = vim.api.nvim_get_current_line():sub(1, params.position.character)
        requests[#requests+1] = {prefix=prefix,at=vim.uv.hrtime()/1e6}
        vim.g.nido_completion_test_requests = requests
        result = {isIncomplete=false,items={}}
        local labels = (vim.g.nido_completion_test_labels or {})[prefix]
          or {'printLine','println','printValue'}
        for _, label in ipairs(labels) do
          result.items[#result.items+1] = {label=label,kind=3}
        end
        delay = vim.g.nido_completion_test_delay or 10
      end
      vim.defer_fn(function()
        if prefix then
          replies[#replies+1] = prefix
          vim.g.nido_completion_test_replies = replies
        end
        if notify_reply then notify_reply(id) end
        callback(nil,result)
      end,delay)
      return true,id
    end,
    notify=function() return true end,
    is_closing=function() return closed end,
    terminate=function() closed=true;dispatchers.on_exit(0,0) end,
  }
end})
assert(vim.wait(2000,function()
  local client=vim.lsp.get_clients({bufnr=0,name='nido-completion-test'})[1]
  return client and client.initialized
end,5))
