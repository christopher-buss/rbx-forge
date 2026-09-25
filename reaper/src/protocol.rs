//! The reaper protocol: one JSON object per line (NDJSON).
//!
//! The host (the process that owns the session) writes [`Request`]s to the
//! reaper's stdin; the reaper writes [`Event`]s to its stdout. The TypeScript
//! side of this contract is `src/reaper/protocol.ts`; change both together.
//!
//! | Host → reaper | Meaning |
//! | ------------- | ------- |
//! | `go`          | Admission: the reaper may spawn from now on. |
//! | `spawn`       | Start one worker in its own job (Windows) or process group (POSIX). |
//! | `stop`        | Stop one worker: graceful signal, then forced kill of its tree after `graceMs`. |
//! | `terminate`   | Irreversible end: reject later spawns, stop every worker, exit. |
//!
//! | Reaper → host | Meaning |
//! | ------------- | ------- |
//! | `leased`      | The reaper holds the lease; it waits for `go`. |
//! | `spawned`     | A worker exists (PID and OS start time). |
//! | `rejected`    | A `spawn` did not start a worker. |
//! | `exited`      | A worker's whole tree is gone (or the bound ran out). |
//! | `terminated`  | Every tree is empty; the reaper releases the lease and exits. |

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// One worker to start.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SpawnRequest {
    /// The host's name for the worker, unique among live workers.
    pub id: String,
    /// Absolute path of the executable.
    pub file: String,
    pub args: Vec<String>,
    pub cwd: String,
    /// The complete environment of the worker.
    pub env: BTreeMap<String, String>,
    /// File that receives stdout and stderr (appended). No file: discarded.
    #[serde(default)]
    pub log: Option<String>,
    /// Windows only: join `args` with spaces, without quoting (cmd.exe
    /// command lines that are already escaped).
    #[serde(default)]
    pub verbatim: bool,
}

/// A message from the host.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase", tag = "type")]
pub enum Request {
    Go,
    Spawn(SpawnRequest),
    #[serde(rename_all = "camelCase")]
    Stop {
        id: String,
        grace_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    Terminate {
        grace_ms: u64,
    },
}

/// How one worker ended.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    /// The leader's exit code; `null` when a signal ended it (POSIX).
    pub exit_code: Option<i32>,
    /// The signal number that ended the leader (POSIX only).
    pub signal: Option<i32>,
    /// The reaper had to kill the tree: the graceful stop did not empty it
    /// in time, or members outlived the leader.
    pub forced: bool,
    /// Members were still alive when the confirmation bound ran out.
    pub incomplete: bool,
}

/// Why a `spawn` started no worker.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RejectReason {
    /// `go` has not arrived.
    NotAdmitted,
    /// `terminate` (or stdin EOF) came first; the reaper never spawns again.
    Terminating,
    /// A live worker has this id.
    DuplicateId,
    /// The OS could not start the process.
    SpawnFailed,
}

/// One entry of `terminated`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct FinalReport {
    pub id: String,
    pub report: Report,
}

/// A message to the host.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum Event {
    Leased {
        pid: u32,
    },
    #[serde(rename_all = "camelCase")]
    Spawned {
        id: String,
        pid: u32,
        /// OS start time as a decimal string (see `os::process`).
        start_time: String,
    },
    Rejected {
        id: String,
        reason: RejectReason,
        message: String,
    },
    Exited {
        id: String,
        report: Report,
    },
    /// Every worker the reaper ever spawned, in spawn order.
    Terminated {
        reports: Vec<FinalReport>,
    },
}

/// Read one request line.
///
/// # Errors
///
/// When the line is not a valid request.
pub fn parse_request(line: &str) -> serde_json::Result<Request> {
    serde_json::from_str(line)
}

/// Write one event as a line, newline included.
#[must_use]
pub fn encode_event(event: &Event) -> String {
    let mut line = serde_json::to_string(event).expect("events always serialize");
    line.push('\n');
    line
}

#[cfg(test)]
mod tests {
    use super::{Event, RejectReason, Report, Request, SpawnRequest, encode_event, parse_request};
    use std::collections::BTreeMap;

    #[test]
    fn parses_every_request() {
        assert_eq!(parse_request(r#"{"type":"go"}"#).unwrap(), Request::Go);
        assert_eq!(
            parse_request(r#"{"type":"stop","id":"rojo","graceMs":250}"#).unwrap(),
            Request::Stop {
                id: "rojo".into(),
                grace_ms: 250
            }
        );
        assert_eq!(
            parse_request(r#"{"type":"terminate","graceMs":0}"#).unwrap(),
            Request::Terminate { grace_ms: 0 }
        );
    }

    #[test]
    fn parses_a_spawn_with_defaults() {
        let line = r#"{"type":"spawn","id":"rojo","file":"/bin/rojo","args":["serve"],"cwd":"/p","env":{"A":"1"}}"#;
        assert_eq!(
            parse_request(line).unwrap(),
            Request::Spawn(SpawnRequest {
                id: "rojo".into(),
                file: "/bin/rojo".into(),
                args: vec!["serve".into()],
                cwd: "/p".into(),
                env: BTreeMap::from([("A".into(), "1".into())]),
                log: None,
                verbatim: false,
            })
        );
    }

    #[test]
    fn rejects_unknown_types_and_bad_json() {
        assert!(parse_request(r#"{"type":"explode"}"#).is_err());
        assert!(parse_request("not json").is_err());
    }

    #[test]
    fn encodes_events_as_camel_case_lines() {
        assert_eq!(
            encode_event(&Event::Spawned {
                id: "rojo".into(),
                pid: 7,
                start_time: "99".into()
            }),
            "{\"type\":\"spawned\",\"id\":\"rojo\",\"pid\":7,\"startTime\":\"99\"}\n"
        );
        assert_eq!(
            encode_event(&Event::Rejected {
                id: "a".into(),
                reason: RejectReason::NotAdmitted,
                message: "m".into()
            }),
            "{\"type\":\"rejected\",\"id\":\"a\",\"reason\":\"not_admitted\",\"message\":\"m\"}\n"
        );
        assert_eq!(
            encode_event(&Event::Exited {
                id: "a".into(),
                report: Report {
                    exit_code: Some(0),
                    ..Report::default()
                }
            }),
            "{\"type\":\"exited\",\"id\":\"a\",\"report\":{\"exitCode\":0,\"signal\":null,\"forced\":false,\"incomplete\":false}}\n"
        );
    }
}
