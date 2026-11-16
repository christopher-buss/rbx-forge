//! Versioned Studio control over an inherited stdio channel.
use crate::os::process::PinnedProcess;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    id: String,
    deadline_ms: u64,
    #[serde(flatten)]
    operation: Operation,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Operation {
    Handshake {
        protocol: u32,
    },
    PluginsFolder,
    ProbeHttp {
        port: u16,
        route: String,
    },
    ProcessStartTime {
        pid: u32,
    },
    ReadRegistry {
        key: String,
    },
    IsBlocked {
        pin: String,
    },
    Desktop {
        pin: String,
    },
    SetWindowVisibility {
        pin: String,
        visibility: String,
    },
    StartWindowHiding {
        pin: String,
    },
    StopWindowHiding {
        pin: String,
    },
    WindowHiding {
        pin: String,
    },
    WindowVisibility {
        pin: String,
    },
    Pin {
        pid: u32,
        #[serde(rename = "startTime")]
        start_time: String,
    },
    Launch {
        program: String,
        args: Vec<String>,
        cwd: String,
        #[serde(default)]
        env: HashMap<String, String>,
        output: Option<String>,
        desktop: Option<String>,
        #[serde(default, rename = "hiddenWindows")]
        hidden_windows: bool,
    },
    Release {
        pin: String,
    },
    IsAlive {
        pin: String,
    },
    ExecutablePath {
        pin: String,
    },
    RequestClose {
        pin: String,
    },
    Kill {
        pin: String,
    },
}

fn failure(id: Value, code: &str, message: impl ToString) -> Value {
    json!({"id": id, "error": {"code": code, "message": message.to_string()}})
}

struct Session {
    ready: bool,
    serial: u64,
    pins: HashMap<String, PinnedProcess>,
}

impl Session {
    fn retain(&mut self, pin: PinnedProcess) -> Value {
        self.serial += 1;
        let key = self.serial.to_string();
        let result =
            json!({"pin": key, "pid": pin.pid(), "startTime": pin.start_time().to_string()});
        self.pins.insert(key, pin);
        result
    }

    fn execute(&mut self, op: Operation) -> io::Result<Value> {
        if let Operation::Handshake { protocol } = op {
            if protocol != 1 {
                return Err(io::Error::other("unsupported protocol"));
            }
            #[cfg(windows)]
            {
                let (hostname, windows_arch) = crate::windows_studio::host_identity()?;
                self.ready = true;
                let helper_arch = match std::env::consts::ARCH {
                    "x86_64" => "x64",
                    "aarch64" => "arm64",
                    other => other,
                };
                return Ok(
                    json!({"protocol": 1, "helperArch": helper_arch, "windowsArch": windows_arch, "hostname": hostname}),
                );
            }
            #[cfg(not(windows))]
            return Err(io::Error::other("Windows helper requires Windows"));
        }
        if !self.ready {
            return Err(io::Error::other("handshake required"));
        }
        match op {
            Operation::Handshake { .. } => unreachable!(),
            Operation::PluginsFolder => {
                let home = std::env::var_os("USERPROFILE")
                    .ok_or_else(|| io::Error::other("Windows user profile is unavailable"))?;
                Ok(json!(
                    std::path::PathBuf::from(home)
                        .join("AppData")
                        .join("Local")
                        .join("Roblox")
                        .join("Plugins")
                ))
            }
            Operation::ProbeHttp { port, route } => {
                Ok(json!(crate::helper_probe::probe(port, &route)?))
            }
            Operation::ProcessStartTime { pid } => Ok(json!(
                crate::os::process::start_time(pid)?.map(|time| time.to_string())
            )),
            Operation::ReadRegistry { key } => {
                #[cfg(windows)]
                {
                    Ok(json!(crate::os::win::registry::read_user_default(&key)?))
                }
                #[cfg(not(windows))]
                {
                    let _ = key;
                    Err(io::Error::other("Windows only"))
                }
            }
            Operation::Pin { pid, start_time } => {
                let start: u64 = start_time.parse().map_err(io::Error::other)?;
                let pin = PinnedProcess::open(pid)?
                    .filter(|pin| pin.start_time() == start)
                    .ok_or_else(|| io::Error::other("process identity mismatch"))?;
                Ok(self.retain(pin))
            }
            Operation::Launch {
                program,
                args,
                cwd,
                env,
                output,
                desktop,
                hidden_windows,
            } => {
                #[cfg(windows)]
                {
                    // Overrides are applied to Windows' environment, never a Linux environment block.
                    let mut environment: Vec<(String, String)> = std::env::vars().collect();
                    for (name, value) in env {
                        environment.retain(|(key, _)| !key.eq_ignore_ascii_case(&name));
                        environment.push((name, value));
                    }
                    let pin =
                        crate::windows_studio::launch_pinned(&crate::windows_studio::Detached {
                            program: &program,
                            args: &args,
                            cwd: &cwd,
                            env: &environment,
                            output: output.as_deref(),
                            desktop: desktop.as_deref(),
                            hidden_windows,
                        })?
                        .ok_or_else(|| io::Error::other("detached launch unavailable"))?;
                    Ok(self.retain(pin))
                }
                #[cfg(not(windows))]
                {
                    let _ = (program, args, cwd, env, output, desktop, hidden_windows);
                    Err(io::Error::other("Windows only"))
                }
            }
            Operation::Release { pin } => Ok(json!(self.pins.remove(&pin).is_some())),
            operation => {
                let (Operation::IsAlive { pin }
                | Operation::IsBlocked { pin }
                | Operation::WindowVisibility { pin }
                | Operation::Desktop { pin }
                | Operation::SetWindowVisibility { pin, .. }
                | Operation::StartWindowHiding { pin }
                | Operation::StopWindowHiding { pin }
                | Operation::WindowHiding { pin }
                | Operation::ExecutablePath { pin }
                | Operation::RequestClose { pin }
                | Operation::Kill { pin }) = &operation
                else {
                    unreachable!()
                };
                let pinned = self
                    .pins
                    .get(pin)
                    .ok_or_else(|| io::Error::other("unknown pin"))?;
                match operation {
                    Operation::IsAlive { .. } => Ok(json!(pinned.is_alive()?)),
                    Operation::IsBlocked { .. } => Ok(json!(pinned.is_blocked()?)),
                    Operation::WindowVisibility { .. } => Ok(json!(pinned.window_visibility()?)),
                    Operation::SetWindowVisibility { visibility, .. } => {
                        Ok(json!(pinned.set_window_visibility(&visibility)?))
                    }
                    Operation::StartWindowHiding { .. } => Ok(json!(pinned.start_window_hiding()?)),
                    Operation::StopWindowHiding { .. } => Ok(json!(pinned.stop_window_hiding()?)),
                    Operation::WindowHiding { .. } => Ok(json!(pinned.window_hiding()?)),
                    Operation::Desktop { .. } => {
                        #[cfg(windows)]
                        {
                            Ok(json!(
                                if crate::os::win::desktop::for_process(pinned.pid())?.name()?
                                    == crate::os::win::desktop::HIDDEN_NAME
                                {
                                    "hidden"
                                } else {
                                    "user"
                                }
                            ))
                        }
                        #[cfg(not(windows))]
                        {
                            Ok(json!("user"))
                        }
                    }
                    Operation::ExecutablePath { .. } => Ok(json!(pinned.executable_path()?)),
                    Operation::RequestClose { .. } => Ok(json!(pinned.request_close()?)),
                    Operation::Kill { .. } => Ok(json!(pinned.kill()?)),
                    _ => unreachable!(),
                }
            }
        }
    }

    fn reply(&mut self, line: &[u8]) -> Value {
        let value: Value = match serde_json::from_slice(line) {
            Ok(value) => value,
            Err(err) => return failure(Value::Null, "malformed_request", err),
        };
        let id = value
            .get("id")
            .filter(|id| id.is_string())
            .cloned()
            .unwrap_or(Value::Null);
        let request: Request = match serde_json::from_value(value) {
            Ok(request) => request,
            Err(err) => return failure(id, "malformed_request", err),
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("after epoch")
            .as_millis();
        if u128::from(request.deadline_ms) <= now {
            return failure(
                id,
                "deadline_exceeded",
                "request deadline elapsed before execution",
            );
        }
        match self.execute(request.operation) {
            Ok(result) => json!({"id": request.id, "result": result}),
            Err(err) => failure(id, "operation_failed", err),
        }
    }
}

/// EOF releases pins. Dropping a pin never terminates its process.
pub fn serve(mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    let mut session = Session {
        ready: false,
        serial: 0,
        pins: HashMap::new(),
    };
    loop {
        let mut line = Vec::new();
        let mut too_long = false;
        loop {
            let buffer = input.fill_buf()?;
            if buffer.is_empty() {
                break;
            }
            let count = buffer
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(buffer.len(), |n| n + 1);
            if line.len() + count > 1024 * 1024 {
                too_long = true;
            }
            if !too_long {
                line.extend_from_slice(&buffer[..count]);
            }
            let newline = buffer[count - 1] == b'\n';
            input.consume(count);
            if newline {
                break;
            }
        }
        if line.is_empty() && !too_long {
            return Ok(());
        }
        let reply = if too_long {
            failure(Value::Null, "malformed_request", "line exceeds 1 MiB")
        } else {
            session.reply(&line)
        };
        serde_json::to_writer(&mut output, &reply)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::serve;
    use serde_json::Value;

    fn exchange(input: &str) -> Vec<Value> {
        let mut output = Vec::new();
        serve(input.as_bytes(), &mut output).unwrap();
        String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[cfg(windows)]
    #[test]
    fn handshake_reports_version_and_windows_identity() {
        let replies = exchange(
            "{\"id\":\"hello\",\"deadlineMs\":4102444800000,\"op\":\"handshake\",\"protocol\":1}\n",
        );
        assert_eq!(replies.len(), 1);
        assert_eq!(replies[0]["id"], "hello");
        assert_eq!(replies[0]["result"]["protocol"], 1);
        assert!(
            replies[0]["result"]["hostname"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
        assert!(replies[0]["result"]["helperArch"].is_string());
        assert!(replies[0]["result"]["windowsArch"].is_string());
        assert_ne!(replies[0], Value::Null);
    }
    #[test]
    fn expired_requests_have_no_side_effect_and_keep_the_id() {
        let replies =
            exchange("{\"id\":\"late\",\"deadlineMs\":0,\"op\":\"kill\",\"pin\":\"1\"}\n");
        assert_eq!(replies[0]["id"], "late");
        assert_eq!(replies[0]["error"]["code"], "deadline_exceeded");
    }

    #[test]
    fn malformed_input_gets_a_reply_and_does_not_end_the_channel() {
        let replies = exchange(
            "bad json\n{\"id\":\"bad\",\"deadlineMs\":4102444800000,\"op\":\"unknown\"}\n",
        );
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0]["id"], Value::Null);
        assert_eq!(replies[1]["id"], "bad");
        assert_eq!(replies[1]["error"]["code"], "malformed_request");
    }

    #[test]
    fn eof_exits_without_an_unsolicited_reply() {
        assert!(exchange("").is_empty());
    }

    #[test]
    fn unsupported_versions_and_commands_before_handshake_are_refused() {
        let replies = exchange(
            "{\"id\":\"v\",\"deadlineMs\":4102444800000,\"op\":\"handshake\",\"protocol\":2}\n{\"id\":\"p\",\"deadlineMs\":4102444800000,\"op\":\"pin\",\"pid\":1,\"startTime\":\"1\"}\n",
        );
        assert_eq!(replies[0]["error"]["message"], "unsupported protocol");
        assert_eq!(replies[1]["error"]["message"], "handshake required");
    }

    #[test]
    fn oversized_input_is_bounded_and_the_next_request_is_read() {
        let input = format!("{}\nbad\n", "x".repeat(1024 * 1024 + 1));
        let replies = exchange(&input);
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0]["error"]["message"], "line exceeds 1 MiB");
    }
}
