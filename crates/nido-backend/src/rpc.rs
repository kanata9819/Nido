use anyhow::{Context, Result, anyhow, bail};
use rmpv::Value as Msg;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
    time::{Duration, Instant},
};

type Reply = std::result::Result<Value, String>;
type Pending = Arc<Mutex<HashMap<u64, Sender<Reply>>>>;
struct Request {
    id: u64,
    pending: Pending,
    receiver: Receiver<Reply>,
}
impl Request {
    fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> std::result::Result<Reply, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}

#[derive(Debug)]
pub enum Event {
    Notify(String, String, Value),
    Result(String, String, Value),
    Error(String),
    Closed(String),
}

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

type PromptHandler = Arc<dyn Fn(&Rpc) + Send + Sync>;

pub struct Rpc {
    child: Child,
    writer: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next: AtomicU64,
    closed: Arc<AtomicBool>,
    pub prompt_handler: Mutex<Option<PromptHandler>>,
}

impl Rpc {
    pub fn spawn(
        mut command: Command,
        id: String,
        events: Sender<Event>,
        repaint: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self> {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Unable to start Neovim")?;
        let writer = Arc::new(Mutex::new(
            child.stdin.take().context("Neovim stdin missing")?,
        ));
        let stdout = child.stdout.take().context("Neovim stdout missing")?;
        let stderr = child.stderr.take().context("Neovim stderr missing")?;
        let pending: Pending = Arc::default();
        let closed = Arc::new(AtomicBool::new(false));
        let read_pending = pending.clone();
        let read_closed = closed.clone();
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(message) = rmpv::decode::read_value(&mut reader) {
                let Some(parts) = message.as_array() else {
                    continue;
                };
                match parts.first().and_then(Msg::as_u64) {
                    Some(1) if parts.len() == 4 => {
                        if let Some(tx) = parts[1]
                            .as_u64()
                            .and_then(|n| read_pending.lock().ok()?.remove(&n))
                        {
                            let result = if parts[2].is_nil() {
                                Ok(to_json(&parts[3]))
                            } else {
                                Err(to_json(&parts[2]).to_string())
                            };
                            let _ = tx.send(result);
                        }
                    }
                    Some(2) if parts.len() == 3 => {
                        let _ = events.send(Event::Notify(
                            id.clone(),
                            parts[1].as_str().unwrap_or_default().to_owned(),
                            to_json(&parts[2]),
                        ));
                        repaint();
                    }
                    _ => {}
                }
            }
            read_closed.store(true, Ordering::Release);
            for (_, tx) in read_pending.lock().unwrap().drain() {
                let _ = tx.send(Err("Neovim connection closed".into()));
            }
            let _ = events.send(Event::Closed(id));
            repaint();
        });
        thread::spawn(move || {
            use std::io::Read;
            // Drain the pipe so a noisy child cannot deadlock on stderr.
            let _ = std::io::copy(&mut stderr.take(u64::MAX), &mut std::io::sink());
        });
        Ok(Self {
            child,
            writer,
            pending,
            next: AtomicU64::new(1),
            closed,
            prompt_handler: Mutex::new(None),
        })
    }

    fn request(&self, method: &str, args: Value) -> Result<Request> {
        if self.closed.load(Ordering::Acquire) {
            bail!("Neovim session is closed")
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let result = self.write(json!([0, id, method, args]));
        if let Err(error) = result {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        Ok(Request {
            id,
            pending: self.pending.clone(),
            receiver: rx,
        })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn call(&self, method: &str, args: Value) -> Result<Value> {
        let reply = self.request(method, args)?;
        let start = Instant::now();
        let mut probe = Instant::now();
        loop {
            match reply.recv_timeout(Duration::from_millis(10)) {
                Ok(result) => return result.map_err(|error| anyhow!(error)),
                Err(mpsc::RecvTimeoutError::Disconnected) => bail!("Neovim connection closed"),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if start.elapsed() > Duration::from_secs(15) {
                bail!("Neovim request timed out: {method}")
            }
            if probe.elapsed() > Duration::from_millis(50) && method != "nvim_get_mode" {
                probe = Instant::now();
                if let Ok(Ok(mode)) = self
                    .request("nvim_get_mode", json!([]))?
                    .recv_timeout(Duration::from_millis(50))
                    && (mode["blocking"] == true
                        || mode["mode"].as_str().unwrap_or("").starts_with('r'))
                {
                    let handler = self.prompt_handler.lock().unwrap().clone();
                    if let Some(handler) = handler {
                        handler(self);
                    }
                }
            }
        }
    }

    pub fn lua(&self, code: &str, args: Value) -> Result<Value> {
        self.call("nvim_exec_lua", json!([code, args]))
    }

    fn write(&self, message: Value) -> Result<()> {
        let message = rmpv::ext::to_value(message)?;
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| anyhow!("Neovim writer failed"))?;
        rmpv::encode::write_value(&mut *writer, &message)?;
        writer.flush()?;
        Ok(())
    }

    pub fn input(&self, text: &str) -> Result<()> {
        let mut rest = text;
        let start = Instant::now();
        while !rest.is_empty() {
            let count = self
                .call("nvim_input", json!([rest]))?
                .as_u64()
                .context("Invalid input acknowledgement")? as usize;
            if count > rest.len() || !rest.is_char_boundary(count) {
                bail!("Invalid UTF-8 input acknowledgement")
            }
            rest = &rest[count..];
            if count == 0 {
                if start.elapsed() > Duration::from_secs(10) {
                    bail!("Neovim input queue is full")
                }
                thread::sleep(Duration::from_millis(2));
            }
        }
        Ok(())
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        let _ = self.write(json!([2, "nvim_command", ["qa!"]]));
        for _ in 0..100 {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn to_json(value: &Msg) -> Value {
    match value {
        Msg::Nil => Value::Null,
        Msg::Boolean(v) => json!(v),
        Msg::Integer(v) => v.as_i64().map_or_else(|| json!(v.as_u64()), |n| json!(n)),
        Msg::F32(v) => json!(v),
        Msg::F64(v) => json!(v),
        Msg::String(v) => json!(v.as_str().unwrap_or_default()),
        Msg::Binary(v) => json!(v),
        Msg::Array(v) => Value::Array(v.iter().map(to_json).collect()),
        Msg::Map(v) => Value::Object(
            v.iter()
                .map(|(k, v)| {
                    (
                        k.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| to_json(k).to_string()),
                        to_json(v),
                    )
                })
                .collect(),
        ),
        Msg::Ext(_, bytes) => rmpv::decode::read_value(&mut &bytes[..])
            .map(|v| to_json(&v))
            .unwrap_or(Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_neovim_handles_and_unicode() {
        assert_eq!(to_json(&Msg::Ext(0, vec![42])), json!(42));
        assert_eq!(to_json(&Msg::from("日本語")), json!("日本語"));
    }
}
