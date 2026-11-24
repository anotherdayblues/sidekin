use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Sender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

type Reply = Sender<Result<Value, String>>;
pub type Events = Arc<dyn Fn(&str, Value) + Send + Sync>;
#[derive(Clone)]
pub struct Client(Sender<CommandMsg>);
enum CommandMsg {
    Request(String, Value, Reply),
    Stop,
    Restart(Reply),
    Output(u64, Value),
    Closed(u64),
    HostReply(u64, Value),
}

impl Client {
    pub fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        self.0
            .send(CommandMsg::Request(method.into(), params, tx))
            .map_err(|_| "disabled")?;
        if matches!(method, "chat" | "translate" | "vision") {
            return rx.recv().map_err(|_| "crash".to_owned())?;
        }
        rx.recv_timeout(Duration::from_secs(
            if matches!(method, "review" | "preview" | "test") {
                420
            } else {
                70
            },
        ))
        .map_err(|_| "timeout".to_owned())?
    }
}
struct Process {
    child: Child,
    stdin: ChildStdin,
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Process {
    fn send(&mut self, value: Value) -> Result<(), String> {
        writeln!(self.stdin, "{value}")
            .and_then(|_| self.stdin.flush())
            .map_err(|_| "crash".into())
    }
}
/// Never persist raw stderr: SDK errors can include the entire request body or headers.
fn safe_diagnostic(line: &str) -> &'static str {
    if line.contains("out of memory") {
        "runtime: out of memory"
    } else if line.contains("panic") {
        "runtime: panic"
    } else if line.contains("error") || line.contains("Error") {
        "runtime: error"
    } else {
        "runtime: diagnostic"
    }
}
pub fn log(dir: &Path, message: &str) {
    static LOCK: Mutex<()> = Mutex::new(());
    let Ok(_guard) = LOCK.lock() else { return };
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join("brain.log");
    if path.metadata().is_ok_and(|m| m.len() >= 256 * 1024) {
        let _ = fs::rename(&path, dir.join("brain.1.log"));
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            f,
            "{} {message}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );
    }
}
fn spawn(
    exe: &Path,
    args: &[String],
    generation: u64,
    channel: &Sender<CommandMsg>,
    dir: &Path,
) -> Result<Process, String> {
    let mut command = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "crash")?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let tx = channel.clone();
    let dir = dir.to_owned();
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            log(&dir, safe_diagnostic(&line));
        }
    });
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str(&line) {
                if tx.send(CommandMsg::Output(generation, value)).is_err() {
                    return;
                }
            }
        }
        let _ = tx.send(CommandMsg::Closed(generation));
    });
    Ok(Process { child, stdin })
}

pub struct Supervisor {
    pub client: Client,
    worker: Option<JoinHandle<()>>,
}
impl Supervisor {
    pub fn watch(
        exe: PathBuf,
        args: Vec<String>,
        config: Value,
        dir: PathBuf,
        events: Events,
    ) -> Self {
        Self::with_host(exe, args, config, dir, events, None)
    }
    pub fn with_host(
        exe: PathBuf,
        args: Vec<String>,
        mut config: Value,
        dir: PathBuf,
        events: Events,
        host: Option<Arc<crate::host::Host>>,
    ) -> Self {
        let (tx, rx) = mpsc::channel();
        let client = Client(tx.clone());
        let worker = thread::spawn(move || {
            let mut generation = 0;
            let mut seq = 0u64;
            let mut process: Option<Process> = None;
            let mut pending: HashMap<u64, Reply> = HashMap::new();
            let mut queued: Vec<(String, Value, Reply)> = Vec::new();
            let mut due = Instant::now();
            let mut started = due;
            let mut ready = false;
            let mut failures = 0u32;
            loop {
                if process.is_none() && Instant::now() >= due {
                    generation += 1;
                    started = Instant::now();
                    ready = false;
                    process=spawn(&exe,&args,generation,&tx,&dir).and_then(|mut p| {
                        p.send(json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":config}))?;Ok(p)
                    }).ok();
                    if process.is_none() {
                        let _ = tx.send(CommandMsg::Closed(generation));
                    }
                }
                // A ready sidecar sends output and EOF through this same channel.
                // Only initialization and crash backoff have a deadline.
                let startup_deadline = started + Duration::from_secs(5);
                let cmd = if ready {
                    rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                } else {
                    let deadline = if process.is_some() {
                        startup_deadline
                    } else {
                        due
                    };
                    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                };
                let mut failed = false;
                match cmd {
                    Ok(CommandMsg::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Ok(CommandMsg::Restart(reply)) => {
                        process.take();
                        due = Instant::now();
                        ready = false;
                        for (_, r) in pending.drain() {
                            let _ = r.send(Err("crash".into()));
                        }
                        let _ = reply.send(Ok(Value::Null));
                        continue;
                    }
                    Ok(CommandMsg::HostReply(g, value)) => {
                        if g == generation {
                            if let Some(p) = process.as_mut() {
                                failed = p.send(value).is_err();
                            }
                        }
                    }
                    Ok(CommandMsg::Closed(g)) => {
                        failed = g == generation;
                    }
                    Ok(CommandMsg::Output(g, value))
                        if g == generation && process.is_some() && value["jsonrpc"] == "2.0" =>
                    {
                        // An incoming request has its own id namespace. It can have the
                        // same id as a pending Rust request and may arrive between deltas.
                        if let (Some(method), Some(id)) =
                            (value["method"].as_str(), value.get("id"))
                        {
                            if method == "host.authorize" {
                                if let Some(host) = host.clone() {
                                    let args = value["params"].clone();
                                    let id = id.clone();
                                    let output = tx.clone();
                                    let events = events.clone();
                                    thread::spawn(move || {
                                        let ok = host
                                            .has_token(args["token"].as_str().unwrap_or(""))
                                            && host
                                                .external
                                                .authorize(
                                                    &args,
                                                    &events,
                                                    Duration::from_secs(120),
                                                    || {
                                                        host.has_token(
                                                            args["token"].as_str().unwrap_or(""),
                                                        )
                                                    },
                                                )
                                                .unwrap_or(false);
                                        let _ = output.send(CommandMsg::HostReply(
                                            g,
                                            json!({"jsonrpc":"2.0","id":id,"result":ok}),
                                        ));
                                    });
                                    continue;
                                }
                            }
                            let response = if method == "host.time" {
                                json!({"jsonrpc":"2.0","id":id,"result":crate::chat::now()})
                            } else if let Some(host) = &host {
                                match host.call(method, &value["params"]) {
                                    Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                                    Err(message) => {
                                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32004,"message":message}})
                                    }
                                }
                            } else {
                                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"未知后台方法"}})
                            };
                            failed = process.as_mut().unwrap().send(response).is_err();
                        } else if let Some(id) = value["id"].as_u64() {
                            if id == 0 {
                                ready = value["result"]["ready"] == true;
                                failed = !ready;
                                if ready {
                                    log(
                                        &dir,
                                        &format!("ready {} ms", started.elapsed().as_millis()),
                                    );
                                    events(
                                        "ready",
                                        json!({"pid":process.as_ref().unwrap().child.id()}),
                                    );
                                }
                            } else if let Some(reply) = pending.remove(&id) {
                                let result = value.get("result").cloned().ok_or_else(|| {
                                    value["error"]["message"]
                                        .as_str()
                                        .unwrap_or("model")
                                        .to_owned()
                                });
                                let _ = reply.send(result);
                            }
                        } else if let Some(method) = value["method"].as_str() {
                            events(method, value["params"].clone());
                        }
                    }
                    Ok(CommandMsg::Request(method, params, reply)) => {
                        if method == "configure" {
                            config = params.clone();
                        }
                        if process.is_none() {
                            let _ = reply.send(Err("crash".into()));
                        } else {
                            queued.push((method, params, reply));
                        }
                    }
                    _ => {}
                }
                if ready && !failed {
                    for (method, params, reply) in queued.drain(..) {
                        if method == "pid" {
                            let _ = reply.send(Ok(json!(process.as_ref().unwrap().child.id())));
                            continue;
                        }
                        seq += 1;
                        pending.insert(seq, reply);
                        if process
                            .as_mut()
                            .unwrap()
                            .send(json!({"jsonrpc":"2.0","id":seq,"method":method,"params":params}))
                            .is_err()
                        {
                            failed = true;
                        }
                    }
                } else if process.is_some() && !ready && Instant::now() >= startup_deadline {
                    failed = true;
                }
                if failed {
                    if ready && started.elapsed() > Duration::from_secs(10) {
                        failures = 0;
                    }
                    process.take();
                    ready = false;
                    generation += 1;
                    let delay = (1u64 << failures.min(5)).min(30);
                    failures = failures.saturating_add(1);
                    due = Instant::now() + Duration::from_secs(delay);
                    for (_, r) in pending.drain() {
                        let _ = r.send(Err("crash".into()));
                    }
                    for (_, _, r) in queued.drain(..) {
                        let _ = r.send(Err("crash".into()));
                    }
                    log(&dir, &format!("restart in {delay}s"));
                    events("crash", json!({"retrySeconds":delay,"attempt":failures}));
                }
            }
            for (_, r) in pending.drain() {
                let _ = r.send(Err("disabled".into()));
            }
        });
        Self {
            client,
            worker: Some(worker),
        }
    }
    fn start(exe: PathBuf, args: Vec<String>, config: Value) -> Result<Self, String> {
        let brain = Self::watch(
            exe,
            args,
            config,
            std::env::temp_dir().join("pet-studio-probe"),
            Arc::new(|_, _| {}),
        );
        brain.client.call("ping", Value::Null)?;
        Ok(brain)
    }
    fn ping(&self) -> Result<(u32, Value), String> {
        Ok((
            self.client.call("pid", Value::Null)?.as_u64().unwrap() as u32,
            self.client.call("ping", Value::Null)?,
        ))
    }
    fn restart(&self) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.client
            .0
            .send(CommandMsg::Restart(tx))
            .map_err(|_| "crash")?;
        rx.recv().map_err(|_| "crash")??;
        Ok(())
    }
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        let _ = self.client.0.send(CommandMsg::Stop);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub fn probe(exe: &Path) -> Result<(), String> {
    // Use a fresh account, never a user's saved provider key.
    let account = format!(
        "probe-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let entry =
        keyring::Entry::new(crate::profile::PROBE_KEYS, &account).map_err(|e| e.to_string())?;
    entry
        .set_password("companion-stage0-probe")
        .map_err(|e| e.to_string())?;
    let key = entry.get_password();
    entry.delete_credential().map_err(|e| e.to_string())?;
    let key = key.map_err(|e| e.to_string())?;
    if key != "companion-stage0-probe" {
        return Err("钥匙串回读不一致".into());
    }
    let brain = Supervisor::start(exe.into(), vec![], json!({"apiKey":key}))?;
    let first = brain.ping()?;
    brain.restart()?;
    let second = brain.ping()?;
    if first.0 == second.0 || first.1 != "pong" || second.1 != "pong" {
        return Err("大脑重启检查失败".into());
    }
    drop(brain);
    println!(
        "钥匙串读写通过；大脑 {} → {}，两次 pong，已停止",
        first.0, second.0
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_and_stop() {
        // Run the actual TypeScript entry point, also on a checkout without prebuilt binaries.
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .canonicalize()
            .unwrap();
        let args = vec![
            "--import".to_owned(),
            "tsx".to_owned(),
            root.join("apps/brain/src/main.ts").to_string_lossy().into(),
        ];
        let brain = Supervisor::start("node".into(), args, json!({"apiKey":"fixture"})).unwrap();
        let (first, pong) = brain.ping().unwrap();
        assert_eq!(pong, "pong");
        brain.restart().unwrap();
        let (second, pong) = brain.ping().unwrap();
        assert_ne!(first, second);
        assert_eq!(pong, "pong");
        #[cfg(unix)]
        {
            assert!(Command::new("kill")
                .args(["-KILL", &second.to_string()])
                .status()
                .unwrap()
                .success());
            let deadline = std::time::Instant::now() + Duration::from_secs(6);
            loop {
                if let Ok((pid, Value::String(text))) = brain.ping() {
                    if pid != second && text == "pong" {
                        break;
                    }
                }
                assert!(std::time::Instant::now() < deadline, "崩溃后应自动重启");
                thread::sleep(Duration::from_millis(100));
            }
        }
        drop(brain);
    }
}
#[cfg(test)]
mod transport_tests {
    use super::*;
    #[test]
    fn idle_worker_delivers_first_delta_without_restarting() {
        let tmp = tempfile::tempdir().unwrap();
        let script = r#"const rl=require('node:readline').createInterface({input:process.stdin});
          const send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));
          rl.on('line',line=>{const r=JSON.parse(line);
            if(r.method==='chat')send({method:'chat.delta',params:{text:'ok'}});
            send({id:r.id,result:r.method==='initialize'?{ready:true}:process.pid});
          });"#;
        let (tx, rx) = mpsc::channel();
        let brain = Supervisor::watch(
            "node".into(),
            vec!["-e".into(), script.into()],
            json!({}),
            tmp.path().into(),
            Arc::new(move |method, _| {
                if method == "chat.delta" {
                    let _ = tx.send(Instant::now());
                }
            }),
        );
        let pid = brain.client.call("identify", Value::Null).unwrap();
        let mut timings = Vec::new();
        for _ in 0..20 {
            thread::sleep(Duration::from_millis(115));
            let start = Instant::now();
            assert_eq!(brain.client.call("chat", Value::Null).unwrap(), pid);
            timings.push(
                rx.recv_timeout(Duration::from_secs(2))
                    .unwrap()
                    .duration_since(start)
                    .as_micros(),
            );
        }
        timings.sort_unstable();
        eprintln!(
            "idle to first local delta (us): median={} p95={}",
            timings[10], timings[18]
        );
    }

    #[test]
    fn silent_initialization_times_out_and_retries_without_a_client_request() {
        let tmp = tempfile::tempdir().unwrap();
        let marker = tmp.path().join("attempt");
        let script = r#"const fs=require('node:fs'), first=!fs.existsSync(process.argv[1]);
          fs.writeFileSync(process.argv[1],'1');
          require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
            const r=JSON.parse(line);
            if(!first) console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{ready:true}}));
          });"#;
        let (tx, rx) = mpsc::channel();
        let _brain = Supervisor::watch(
            "node".into(),
            vec![
                "-e".into(),
                script.into(),
                marker.to_string_lossy().into_owned(),
            ],
            json!({}),
            tmp.path().into(),
            Arc::new(move |method, _| {
                let _ = tx.send(method.to_owned());
            }),
        );
        assert_eq!(rx.recv_timeout(Duration::from_secs(12)).unwrap(), "crash");
        assert_eq!(rx.recv_timeout(Duration::from_secs(8)).unwrap(), "ready");
    }

    #[test]
    fn separates_events_and_out_of_order_replies() {
        let tmp = tempfile::tempdir().unwrap();
        let script = r#"const rl=require('node:readline').createInterface({input:process.stdin});
        const send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));
        rl.on('line',line=>{const r=JSON.parse(line);if(r.method==='slow')send({method:'chat.delta',params:'waiting'});
          setTimeout(()=>send({id:r.id,result:r.method==='initialize'?{ready:true}:r.method}),r.method==='slow'?150:0);});"#;
        let (tx, rx) = mpsc::channel();
        let brain = Supervisor::watch(
            "node".into(),
            vec!["-e".into(), script.into()],
            json!({"apiKey":"fake"}),
            tmp.path().into(),
            Arc::new(move |m, _| {
                let _ = tx.send(m.to_owned());
            }),
        );
        let c = brain.client.clone();
        let task = thread::spawn(move || c.call("slow", Value::Null));
        while rx.recv_timeout(Duration::from_secs(3)).unwrap() != "chat.delta" {}
        assert_eq!(brain.client.call("fast", Value::Null).unwrap(), "fast");
        assert_eq!(task.join().unwrap().unwrap(), "slow");
    }
    #[test]
    fn stderr_never_persists_provider_payloads() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("brain.log"), vec![b'x'; 256 * 1024]).unwrap();
        log(
            tmp.path(),
            safe_diagnostic("Error: key=secret; image=data:image/png; 私人原文"),
        );
        let text = fs::read_to_string(tmp.path().join("brain.log")).unwrap();
        assert!(
            text.contains("runtime: error") && !text.contains("secret") && !text.contains("原文")
        );
        assert!(tmp.path().join("brain.1.log").exists());
    }
}
#[cfg(test)]
mod inbound_test {
    use super::*;
    #[test]
    fn reverse_rpc_may_reuse_a_pending_request_id() {
        let tmp = tempfile::tempdir().unwrap();
        let fixture = r#"const rl=require('node:readline').createInterface({input:process.stdin});const send=m=>console.log(JSON.stringify({jsonrpc:'2.0',...m}));
        rl.on('line',s=>{const r=JSON.parse(s);if(r.method==='initialize')send({id:r.id,result:{ready:true}});
        else if(r.method==='clock')send({id:r.id,method:'host.time'});else if(typeof r.result==='number')send({id:r.id,result:'clock answered'});});"#;
        let brain = Supervisor::watch(
            "node".into(),
            vec!["-e".into(), fixture.into()],
            json!({"apiKey":""}),
            tmp.path().into(),
            Arc::new(|_, _| {}),
        );
        assert_eq!(
            brain.client.call("clock", Value::Null).unwrap(),
            "clock answered"
        );
    }
}
