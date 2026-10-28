use crate::{
    files, git,
    history::History,
    packs,
    persistence::SavedWorkspace,
    rpc::{self, Event, Rpc},
    wsl::{Remote, editor_path},
};
use anyhow::{Context, Result, bail};
use notify::Watcher;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, mpsc::Sender},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug)]
pub struct Action {
    pub name: String,
    pub args: Value,
    pub tag: String,
}
impl Action {
    pub fn new(name: &str, args: Value) -> Self {
        Self {
            name: name.into(),
            args,
            tag: name.into(),
        }
    }
}
type Queue = Arc<(Mutex<VecDeque<Action>>, Condvar)>;
#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub root: PathBuf,
    pub terminal: bool,
    queue: Queue,
}

pub fn resources() -> Result<PathBuf> {
    let mut choices = vec![];
    if let Some(path) = std::env::var_os("NIDO_RESOURCES") {
        choices.push(PathBuf::from(path));
    }
    if let Some(parent) = std::env::current_exe()?.parent() {
        choices.push(parent.join("resources"));
    }
    choices.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"));
    choices
        .into_iter()
        .find(|p| p.join("nido/init.lua").is_file() && p.join("nvim-win64/bin/nvim.exe").is_file())
        .context("Bundled Neovim is missing. Run scripts/prepare-runtime.ps1")
}

impl Session {
    pub fn start(
        root: PathBuf,
        terminal: bool,
        saved: Option<SavedWorkspace>,
        settings: Value,
        events: Sender<Event>,
        repaint: Arc<dyn Fn() + Send + Sync>,
        data: PathBuf,
    ) -> Self {
        let session = Self {
            id: uuid::Uuid::new_v4().to_string(),
            root,
            terminal,
            queue: Arc::new((Mutex::new(VecDeque::new()), Condvar::new())),
        };
        let worker = session.clone();
        thread::spawn(move || {
            let result = worker.run(saved, settings, events.clone(), repaint.clone(), data);
            if let Err(error) = result {
                let _ = events.send(Event::Error(format!(
                    "{}: {error:#}",
                    worker.root.display()
                )));
            }
            let _ = events.send(Event::Closed(worker.id));
            repaint();
        });
        session
    }
    pub fn send(&self, name: &str, args: Value) {
        self.send_tag(name, args, name);
    }
    pub fn send_tag(&self, name: &str, args: Value, tag: &str) {
        let (lock, wake) = &*self.queue;
        lock.lock().unwrap().push_back(Action {
            name: name.into(),
            args,
            tag: tag.into(),
        });
        wake.notify_one();
    }
    fn run(
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
        let resources = files::normal_path(resources()?);
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
                        "open"=>{let path=files::inside(&self.root,string(0),false)?; open(&rpc,&editor_path(&path,remote.as_ref()),a[1].as_u64().unwrap_or(0) as usize,a[2].as_u64().unwrap_or(1) as usize)?; if settings["historyEnabled"]!=false {capture_history(&mut tokens);} Ok(Value::Null)},
                        "openGit"=>{let path=files::inside(&git::repository(&self.root)?,string(0),false)?; open(&rpc,&editor_path(&path,remote.as_ref()),0,1)?; Ok(Value::Null)},
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
                        "files"=>{let path=files::inside(&self.root,string(0),false)?;let _=watcher.watch(&path,notify::RecursiveMode::NonRecursive);files::entries(&self.root,string(0))},
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

type ReplacementState = Arc<Mutex<Option<files::Replacement>>>;

fn read_worker(
    session: &Session,
    events: Sender<Event>,
    repaint: Arc<dyn Fn() + Send + Sync>,
) -> (Sender<Action>, ReplacementState) {
    let (tx, rx) = std::sync::mpsc::channel::<Action>();
    let root = session.root.clone();
    let id = session.id.clone();
    let replacement: ReplacementState = Arc::default();
    let preview = replacement.clone();
    // File scans and Git hooks must never hold up Neovim input.
    thread::spawn(move || {
        let mut search: Option<files::Search> = None;
        while let Ok(first) = rx.recv() {
            let mut jobs = VecDeque::from([first]);
            jobs.extend(rx.try_iter());
            while let Some(action) = jobs.pop_front() {
                if ["findFiles", "search"].contains(&action.name.as_str())
                    && jobs.iter().any(|next| next.name == action.name)
                {
                    continue;
                }
                let a = &action.args;
                let text = |index: usize| a[index].as_str().unwrap_or_default();
                let result = (|| -> Result<Value> {
                    match action.name.as_str() {
                        "findFiles" => {
                            let query = text(0).to_lowercase();
                            Ok(json!(files::walk(&root, "")?.iter().filter_map(|path| {
                                let name = files::relative(&root, path);
                                fuzzy(&name.to_lowercase(), &query).then(|| json!({"path":name,"name":path.file_name().unwrap_or_default().to_string_lossy()}))
                            }).take(500).collect::<Vec<_>>()))
                        }
                        "search" => {
                            search = None;
                            *preview.lock().unwrap() = None;
                            let result = files::search(&root, text(0), a[1].clone())?;
                            let value = json!({"matches":result.matches,"truncated":result.matches.len()>200,"token":result.token,"query":result.query,"options":result.options});
                            search = Some(result);
                            *preview.lock().unwrap() = None;
                            Ok(value)
                        }
                        "previewReplacement" => {
                            let selected: Vec<usize> = a[2]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|v| v.as_u64().map(|v| v as usize))
                                .collect();
                            let result = search.as_ref().context("Search again")?.preview(
                                &root,
                                text(0),
                                text(1),
                                &selected,
                            )?;
                            let value = json!({"token":result.token,"searchToken":a[0],"replacement":a[1],"files":result.files.iter().map(|(p,b,a,c)|json!({"path":p,"before":b,"after":a,"count":c})).collect::<Vec<_>>()});
                            *preview.lock().unwrap() = Some(result);
                            Ok(value)
                        }
                        "git" => git::action(&root, text(0), &a[1]),
                        _ => bail!("Unknown workspace job"),
                    }
                })();
                let _ = events.send(match result {
                    Ok(value) => Event::Result(id.clone(), action.tag, value),
                    Err(error) => Event::Error(format!("{}: {error:#}", action.name)),
                });
                repaint();
            }
        }
    });
    (tx, replacement)
}

fn fuzzy(value: &str, query: &str) -> bool {
    let mut chars = value.chars();
    query
        .chars()
        .all(|needle| chars.by_ref().any(|c| c == needle))
}

pub fn snapshot(rpc: &Rpc, root: &Path, terminal: bool) -> Result<Value> {
    if terminal {
        return Ok(json!({"root":root,"kind":"terminal","files":[],"current":""}));
    }
    let mut value = rpc.lua(SNAPSHOT, json!([]))?;
    value["root"] = json!(root);
    value["kind"] = json!("editor");
    if !value["files"].is_array() {
        value["files"] = json!([]);
    }
    if let Some(remote) = Remote::parse(root) {
        if let Some(current) = value["current"].as_str() {
            value["current"] = json!(remote.host(current));
        }
        for file in value["files"].as_array_mut().unwrap() {
            if let Some(path) = file["path"].as_str() {
                file["path"] = json!(remote.host(path));
            }
        }
    }
    Ok(value)
}

fn open(rpc: &Rpc, path: &str, line: usize, column: usize) -> Result<()> {
    rpc.lua(
        r#"local path,line,column=...
require('nido_scroll').restore()
require('nido_eol').open(path)
if line>0 then
 vim.cmd.stopinsert();line=math.min(line,vim.api.nvim_buf_line_count(0))
 local text=vim.api.nvim_buf_get_lines(0,line-1,line,false)[1] or ''
 vim.api.nvim_win_set_cursor(0,{line,math.min(math.max(0,column-1),#text)})
 vim.cmd('normal! zvzz')
end"#,
        json!([path, line, column]),
    )?;
    Ok(())
}
fn apply_settings(rpc: &Rpc, settings: &Value, terminal: bool) -> Result<()> {
    rpc.call(
        "nvim_set_option_value",
        json!([
            "clipboard",
            if settings["clipboardSharing"] == true {
                "unnamedplus"
            } else {
                ""
            },
            {}
        ]),
    )?;
    if !terminal {
        rpc.lua(
            r#"local s=vim.json.decode(...)
vim.go.relativenumber=s.relativeLineNumbers==true
vim.go.wrap=s.wordWrap==true
for _,win in ipairs(vim.api.nvim_list_wins()) do
 if vim.api.nvim_win_get_config(win).relative=='' then
  vim.wo[win].relativenumber=vim.go.relativenumber
  if vim.bo[vim.api.nvim_win_get_buf(win)].buftype=='' then vim.wo[win].wrap=vim.go.wrap end
 end
end
require('nido_sticky').set_method_separators(s.methodSeparators==true)
require('nido_editorconfig').set_enabled(s.editorConfig~=false)"#,
            json!([settings.to_string()]),
        )?;
    }
    Ok(())
}
pub fn available_shells() -> Vec<String> {
    ["auto", "pwsh", "powershell.exe", "cmd.exe", "wsl.exe"]
        .into_iter()
        .filter(|s| *s == "auto" || shell(s).is_ok())
        .map(str::to_owned)
        .collect()
}
fn shell(choice: &str) -> Result<Vec<String>> {
    if !["auto", "pwsh", "powershell.exe", "cmd.exe", "wsl.exe"].contains(&choice) {
        bail!("Invalid terminal shell")
    }
    let choices = if choice == "auto" {
        vec!["pwsh", "powershell.exe", "cmd.exe"]
    } else {
        vec![choice]
    };
    for name in choices {
        let mut dirs: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        if let Some(p) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(p).join("PowerShell/7"));
        }
        if let Some(p) = std::env::var_os("SystemRoot") {
            let p = PathBuf::from(p);
            dirs.push(p.join("System32"));
            dirs.push(p.join("System32/WindowsPowerShell/v1.0"));
        }
        for dir in dirs {
            let path = dir.join(if name == "pwsh" { "pwsh.exe" } else { name });
            if path.is_file() {
                let mut args = vec![path.to_string_lossy().into_owned()];
                if name.contains("powershell") || name == "pwsh" {
                    args.push("-NoLogo".into());
                }
                return Ok(args);
            }
        }
    }
    bail!("Shell is not installed: {choice}")
}
fn start_terminal(rpc: &Rpc, settings: &Value, remote: bool) -> Result<()> {
    let choice = settings["terminalShell"].as_str().unwrap_or("auto");
    let command = if remote { vec![] } else { shell(choice)? };
    rpc.lua(
        "require('nido_terminal').start(...)",
        json!([choice, command]),
    )?;
    for _ in 0..100 {
        if rpc.call("nvim_get_mode", json!([]))?["mode"] == "t" {
            return Ok(());
        }
        rpc.call("nvim_command", json!(["startinsert"]))?;
        thread::sleep(Duration::from_millis(10));
    }
    bail!("Terminal input did not become ready")
}
const SAVE: &str = r#"local command,format=...;local buffer=vim.api.nvim_get_current_buf();local failed=false
local ok,err=pcall(function()
 if format and #vim.lsp.get_clients({bufnr=buffer,method='textDocument/formatting'})>0 then failed=not pcall(vim.lsp.buf.format,{bufnr=buffer,async=false,timeout_ms=3000}) end
 if command=='write' then vim.api.nvim_buf_call(buffer,function() vim.cmd({cmd=command,mods={silent=true}}) end) else vim.cmd({cmd=command,mods={silent=true}}) end
end)
if ok and failed then vim.notify('Formatting failed. Your edits were saved without formatting.',vim.log.levels.WARN,{title='Format on save'}) end
return ok and '' or tostring(err)"#;
const SNAPSHOT: &str = r#"local files={}
for _,b in ipairs(vim.api.nvim_list_bufs()) do
 local name=vim.api.nvim_buf_get_name(b)
 if vim.bo[b].buflisted and vim.bo[b].buftype=='' and name~='' then
  local pos=vim.api.nvim_buf_get_mark(b,'"');local wins=vim.fn.win_findbuf(b)
  if #wins>0 then pos=vim.api.nvim_win_get_cursor(wins[1]);if wins[1]==vim.api.nvim_get_current_win() then pos=require('nido_scroll').cursor() or pos end end
  table.insert(files,{path=name,line=math.max(1,pos[1]),column=pos[2]})
 end
end
return {files=files,current=vim.api.nvim_buf_get_name(0)}"#;
