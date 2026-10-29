use super::*;

impl Session {
    pub(super) fn run(
        &self,
        saved: Option<SavedWorkspace>,
        mut settings: Value,
        events: Sender<Event>,
        repaint: Arc<dyn Fn() + Send + Sync>,
        data: PathBuf,
    ) -> Result<()> {
        if !self.root.is_dir() {
            bail!("Choose an existing project folder")
        }
        let resources = paths::normal_path(resources()?);
        let remote = Remote::parse(&self.root);
        let node = if resources.join("node/node.exe").is_file() {
            resources
                .join("node/node.exe")
                .to_string_lossy()
                .into_owned()
        } else {
            "node.exe".into()
        };
        let mut cmd = if let Some(r) = &remote {
            let (nvim, node, mounted) = r.prepare(&resources)?;
            let mut c = r.command(
                "env",
                &[
                    "-u",
                    "VIMRUNTIME",
                    "-u",
                    "VIMINIT",
                    "-u",
                    "EXINIT",
                    "-u",
                    "NVIM",
                    "-u",
                    "NVIM_LISTEN_ADDRESS",
                    "-u",
                    "NODE_OPTIONS",
                    "NVIM_APPNAME=nido",
                    "NIDO_WSL=1",
                    &format!("NIDO_NODE={node}"),
                    &format!("NIDO_LANGUAGES={mounted}/languages"),
                    &format!("NIDO_WORKSPACE_ROOT={}", r.path),
                    &nvim,
                ],
            );
            c.args([
                "--embed",
                "--noplugin",
                "-n",
                "-i",
                "NONE",
                "-u",
                &format!("{mounted}/nido/init.lua"),
            ]);
            c
        } else {
            let mut c = rpc::command(resources.join("nvim-win64/bin/nvim.exe"));
            c.current_dir(&self.root)
                .args(["--embed", "--noplugin", "-n", "-i", "NONE", "-u"])
                .arg(resources.join("nido/init.lua"));
            c.env("NVIM_APPNAME", "nido")
                .env("NIDO_NODE", node)
                .env("NIDO_WORKSPACE_ROOT", &self.root)
                .env("NIDO_LANGUAGES", resources.join("languages"))
                .env(
                    "VIMRUNTIME",
                    resources.join("nvim-win64/share/nvim/runtime"),
                );
            for name in [
                "VIMINIT",
                "EXINIT",
                "NVIM",
                "NVIM_LISTEN_ADDRESS",
                "NODE_OPTIONS",
                "NIDO_LSP_CONFIG",
            ] {
                c.env_remove(name);
            }
            c
        };
        cmd.args(["--cmd", "lua vim.opt.runtimepath = {vim.env.VIMRUNTIME, vim.fn.fnamemodify(vim.v.progpath, ':h:h') .. '/lib/nvim'}; vim.opt.packpath = {}"]);
        let rpc = Rpc::spawn(cmd, self.id.clone(), events.clone(), repaint.clone())?;
        let prompt_queue = self.queue.clone();
        let prompt_events = events.clone();
        let prompt_id = self.id.clone();
        let prompt_repaint = repaint.clone();
        *rpc.prompt_handler.lock().unwrap() = Some(Arc::new(move |rpc| {
            let action = {
                let mut q = prompt_queue.0.lock().unwrap();
                q.iter()
                    .position(|a| a.name == "input" || a.name == "paste")
                    .and_then(|i| q.remove(i))
            };
            if let Some(action) = action {
                let result = if action.name == "input" {
                    rpc.input(action.args[0].as_str().unwrap_or(""))
                } else {
                    rpc.call("nvim_paste", json!([action.args[0], true, -1]))
                        .map(|_| ())
                };
                let _ = prompt_events.send(match result {
                    Ok(()) => Event::Result(prompt_id.clone(), action.tag, Value::Null),
                    Err(error) => Event::Error(format!("Input: {error:#}")),
                });
                prompt_repaint();
            }
        }));
        let channel = rpc.call("nvim_get_api_info", json!([]))?[0].clone();
        rpc.lua(
            &fs::read_to_string(resources.join("nido/session.lua"))?,
            json!([channel]),
        )?;
        rpc.call("nvim_ui_attach",json!([100,32,{"rgb":true,"ext_linegrid":true,"ext_popupmenu":true,"ext_hlstate":true,"ext_messages":true,"ext_cmdline":true}]))?;
        rpc.lua("assert(vim.wait(10000, function() return vim.v.vim_did_enter == 1 end), 'Neovim startup timed out')",json!([]))?;
        rpc.call("nvim_set_option_value", json!(["cmdheight", 1, {}]))?;
        rpc.lua(
            "require('nido_language_packs').apply(vim.json.decode(...))",
            json!([packs::discover(&resources, &data)?.to_string()]),
        )?;
        apply_settings(&rpc, &settings, self.terminal)?;
        if self.terminal {
            start_terminal(&rpc, &settings, remote.is_some())?;
        } else if let Some(saved) = saved {
            for file in saved.files {
                let path = Path::new(&file.path);
                if path.is_file()
                    && let Err(error) = open(
                        &rpc,
                        &editor_path(path, remote.as_ref()),
                        file.line,
                        file.column + 1,
                    )
                {
                    let _ = events.send(Event::Error(format!("{}: {error}", file.path)));
                }
            }
            rpc.lua(
                "local b=vim.fn.bufnr(...); if b>0 then vim.api.nvim_set_current_buf(b) end",
                json!([editor_path(Path::new(&saved.current), remote.as_ref())]),
            )?;
        }
        let _ = events.send(Event::Result(self.id.clone(), "ready".into(), json!({})));
        repaint();
        let watch_queue = self.queue.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result
                    && (event.kind.is_modify() || event.kind.is_create() || event.kind.is_remove())
                {
                    let mut q = watch_queue.0.lock().unwrap();
                    if !q.iter().any(|a| a.name == "filesChanged") {
                        q.push_back(Action::new("filesChanged", json!([])));
                        watch_queue.1.notify_one();
                    }
                }
            })?;
        watcher.watch(&self.root, notify::RecursiveMode::NonRecursive)?;
        let history = History::new(&data);
        let mut tokens = json!([]);
        let mut history_warned = false;
        let mut capture_history =
            |tokens: &mut Value| match history.capture(&rpc, &self.root, tokens) {
                Ok(()) => history_warned = false,
                Err(error) => {
                    if !history_warned {
                        let _ = events.send(Event::Notify(
                            self.id.clone(),
                            "nido:message".into(),
                            json!([error.to_string(), 3, "Time Machine"]),
                        ));
                    }
                    history_warned = true;
                }
            };
        if !self.terminal && settings["historyEnabled"] != false {
            capture_history(&mut tokens);
        }
        let mut tick = Instant::now();
        let mut detached = false;
        let (read_jobs, replacement) = read_worker(self, events.clone(), repaint.clone());
        loop {
            if rpc.is_closed() {
                return Ok(());
            }
            let action = {
                let (lock, wake) = &*self.queue;
                let mut queue = lock.lock().unwrap();
                if queue.is_empty() {
                    queue = wake
                        .wait_timeout(queue, Duration::from_millis(200))
                        .unwrap()
                        .0;
                }
                queue.pop_front()
            };
            if let Some(action) = action {
                if action.name == "stop" {
                    if !self.terminal && settings["historyEnabled"] != false {
                        capture_history(&mut tokens);
                    }
                    return Ok(());
                }
                if ["findFiles", "search", "previewReplacement", "git"]
                    .contains(&action.name.as_str())
                {
                    read_jobs.send(action).context("Workspace worker stopped")?;
                    continue;
                }
                let result = (|| -> Result<Value> {
                    let a = &action.args;
                    let string = |index: usize| a[index].as_str().unwrap_or_default();
                    match action.name.as_str() {
                        "input"=>{
                            if detached {rpc.lua("require('nido_scroll').restore()",json!([]))?;detached=false;}
                            let mode=rpc.call("nvim_get_mode",json!([]))?;
                            let prompt=mode["blocking"]==true || mode["mode"].as_str().unwrap_or("").starts_with(['r','c']);
                            if self.terminal && !prompt { rpc.call("nvim_command",json!(["startinsert"]))?; }
                            let mut input=string(0).to_owned();
                            if !prompt && ["<C-n>","<C-p>"].contains(&input.as_str()) && rpc.call("nvim_eval",json!(["pumvisible()"]))?.as_i64().unwrap_or(0)>0 { input=if input=="<C-n>" {"<Down>"}else{"<Up>"}.into(); }
                            rpc.input(&input)?; Ok(Value::Null)
                        }
                        "paste"=>{rpc.lua("require('nido_scroll').restore()",json!([]))?; if self.terminal {rpc.call("nvim_command",json!(["startinsert"]))?;} rpc.call("nvim_paste",json!([string(0),true,-1]))},
                        "resize"=>rpc.call("nvim_ui_try_resize",a.clone()),
                        "modeShortcut"=>{let fast=rpc.call("nvim_get_mode",json!([]))?;let mode=if fast["blocking"]==true||fast["mode"].as_str().unwrap_or("").starts_with('r'){json!("pending")}else{rpc.call("nvim_eval",json!(["mode(1)"]))?};Ok(json!({"key":a[0],"mode":mode}))},
                        "rpc"=>rpc.call(string(0),a[1].clone()),
                        "lua"=>rpc.lua(string(0),a[1].clone()),
                        "open"=>{let path=paths::inside(&self.root,string(0),false)?; open(&rpc,&editor_path(&path,remote.as_ref()),a[1].as_u64().unwrap_or(0) as usize,a[2].as_u64().unwrap_or(1) as usize)?; if settings["historyEnabled"]!=false {capture_history(&mut tokens);} Ok(Value::Null)},
                        "openGit"=>{let path=paths::inside(&git::repository(&self.root)?,string(0),false)?; open(&rpc,&editor_path(&path,remote.as_ref()),0,1)?; Ok(Value::Null)},
                        "save"=>{
                            rpc.lua("require('nido_scroll').restore()",json!([]))?;
                            if !self.terminal && settings["historyEnabled"]!=false {capture_history(&mut tokens);}
                            let result=rpc.lua(SAVE,json!([a[0].as_str().unwrap_or("write"),settings["formatOnSave"]!=false]))?;
                            if let Some(error)=result.as_str().filter(|s|!s.is_empty()) {bail!("{error}")}
                            if settings["historyEnabled"]!=false {capture_history(&mut tokens);} Ok(Value::Null)
                        }
                        "modified"=>rpc.lua("for _,b in ipairs(vim.api.nvim_list_bufs()) do if vim.bo[b].buftype=='' and vim.bo[b].modified then return true end end return false",json!([])),
                        "snapshot"=>snapshot(&rpc,&self.root,self.terminal),
                        "buffers"=>rpc.lua("local result={}; for _,b in ipairs(vim.api.nvim_list_bufs()) do if vim.bo[b].buflisted then table.insert(result,{id=b,name=vim.api.nvim_buf_get_name(b),modified=vim.bo[b].modified}) end end return result",json!([])),
                        "selectBuffer"=>{rpc.lua("require('nido_scroll').restore()",json!([]))?;rpc.call("nvim_set_current_buf",json!([a[0]]))},
                        "closeBuffer"=>rpc.call("nvim_buf_delete",json!([a[0],{"force":a[1].as_bool().unwrap_or(false)}])),
                        "mouse"=>{rpc.lua("require('nido_scroll').restore(true)",json!([]))?;rpc.call("nvim_input_mouse",a.clone())},
                        "scroll"=>{if self.terminal {rpc.call("nvim_command",json!(["stopinsert"]))?;} let result=rpc.lua("return require('nido_scroll').scroll(...)",json!([a[0],settings["scrollFollowCursor"]!=false,true,a[1]]))?;detached=settings["scrollFollowCursor"]==false;rpc.call("nvim_eval",json!(["1"]))?;Ok(result)},
                        "settings"=>{settings=a.clone();apply_settings(&rpc,&settings,self.terminal)?;Ok(Value::Null)},
                        "restartTerminal"=>{start_terminal(&rpc,&settings,remote.is_some())?;Ok(Value::Null)},
                        "files"=>{let path=paths::inside(&self.root,string(0),false)?;let _=watcher.watch(&path,notify::RecursiveMode::NonRecursive);files::entries(&self.root,string(0))},
                        "filesChanged"=>{rpc.call("nvim_command",json!(["checktime"]))?;rpc.lua("local s=require('nido_git_signs'); if s.refresh_all then s.refresh_all() end",json!([]))?;Ok(Value::Null)},
                        "fileAction"=>{files::mutate(&self.root,&rpc,string(0),string(1),string(2))?;Ok(Value::Null)},
                        "applyReplacement"=>{
                            let preview = replacement.lock().unwrap().take().context("Preview the replacement first")?;
                            preview.apply(&self.root,&rpc,string(0))
                        },
                        "debug"=>rpc.lua("require('nido_scroll').restore();require('nido_debug').action(...)",json!([a[0],channel,a[1].as_u64().unwrap_or(0)])),
                        "packs"=>{let mut config=packs::discover(&resources,&data)?;config["runtime"]=rpc.lua("return require('nido_language_packs').snapshot()",json!([]))?;Ok(config)},
                        "reloadPacks"=>{rpc.lua("require('nido_language_packs').apply(vim.json.decode(...))",json!([packs::discover(&resources,&data)?.to_string()]))?;Ok(Value::Null)},
                        "history"=>history.action(&rpc,&self.root,string(0),&a[1]),
                        "markdown"=>rpc.lua("if vim.bo.filetype~='markdown' then error('Open a Markdown file') end return table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),'\\n')",json!([])),
                        _=>bail!("Unknown action: {}",action.name),
                    }
                })();
                match result {
                    Ok(value) => {
                        let _ = events.send(Event::Result(self.id.clone(), action.tag, value));
                    }
                    Err(error) => {
                        let _ = events.send(Event::Error(format!("{}: {error:#}", action.name)));
                    }
                }
                repaint();
            }
            if tick.elapsed() > Duration::from_secs(5) {
                tick = Instant::now();
                if !self.terminal && settings["historyEnabled"] != false {
                    capture_history(&mut tokens);
                }
                if let Ok(value) = snapshot(&rpc, &self.root, self.terminal) {
                    let _ = events.send(Event::Result(self.id.clone(), "checkpoint".into(), value));
                }
                repaint();
            }
        }
    }
}
