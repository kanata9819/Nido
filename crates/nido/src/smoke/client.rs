use super::*;

pub(super) struct Client {
    pub(super) session: Session,
    rx: Receiver<Event>,
    pub(super) grid: Grid,
    sequence: usize,
    notifications: HashMap<String, Value>,
}
impl Client {
    pub(super) fn start(
        root: &Path,
        data: &Path,
        terminal: bool,
        saved: Option<SavedWorkspace>,
    ) -> Result<Self> {
        let (tx, rx) = mpsc::channel();
        let mut settings = settings::defaults();
        settings["terminalShell"] = json!("cmd.exe");
        let mut client = Self {
            session: Session::start(
                root.into(),
                terminal,
                saved,
                settings,
                tx,
                Arc::new(|| {}),
                data.into(),
            ),
            rx,
            grid: Grid::default(),
            sequence: 0,
            notifications: HashMap::new(),
        };
        client.wait("ready")?;
        Ok(client)
    }
    pub(super) fn wait(&mut self, tag: &str) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Event::Result(_, name, value)) if name == tag => return Ok(value),
                Ok(Event::Notify(_, method, args)) => self.notify(method, args),
                Ok(Event::Error(error)) => bail!("{error}"),
                Ok(Event::Closed(_)) => bail!("Neovim closed while waiting for {tag}"),
                _ => {}
            }
        }
        bail!("Timed out waiting for {tag}")
    }
    pub(super) fn notify(&mut self, method: String, args: Value) {
        self.grid.notify(&method, &args);
        self.notifications.insert(method, args[0].clone());
    }
    pub(super) fn wait_notify(
        &mut self,
        method: &str,
        ready: impl Fn(&Value) -> bool,
    ) -> Result<Value> {
        let deadline = Instant::now() + Duration::from_secs(45);
        while Instant::now() < deadline {
            if let Some(value) = self.notifications.get(method) {
                if value["status"] == "error" {
                    bail!("{method}: {}", value["output"]);
                }
                if ready(value) {
                    return Ok(value.clone());
                }
            }
            match self.rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Event::Notify(_, method, args)) => self.notify(method, args),
                Ok(Event::Error(error)) => bail!("{error}"),
                Ok(Event::Closed(_)) => bail!("Neovim closed while waiting for {method}"),
                _ => {}
            }
        }
        bail!(
            "Timed out waiting for {method}: {:?}",
            self.notifications.get(method)
        )
    }
    pub(super) fn call(&mut self, name: &str, args: Value) -> Result<Value> {
        self.sequence += 1;
        let tag = format!("check:{}", self.sequence);
        self.session.send_tag(name, args, &tag);
        self.wait(&tag)
    }
    pub(super) fn lua(&mut self, code: &str, args: Value) -> Result<Value> {
        self.call("lua", json!([code, args]))
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.session.send("input", json!(["<Esc>"]));
        self.session.send("stop", json!([]));
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(3) {
            if matches!(
                self.rx.recv_timeout(Duration::from_millis(50)),
                Ok(Event::Closed(_))
            ) {
                break;
            }
        }
    }
}
