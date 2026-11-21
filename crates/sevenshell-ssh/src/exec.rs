//! Running one command and collecting what it said.
//!
//! This is the non-interactive half of SSH, and it is deliberately not built on the terminal
//! channel: a terminal is a pty with a size, an echo setting and a shell that waits for input, and a
//! command that is supposed to finish wants none of that. The server runs the command directly, its
//! output arrives as two streams, and the exit status is the answer.
//!
//! What comes back is text, deliberately: the caller of this is a person reading the output of a
//! command they ran, or an interface showing it to them.

use std::time::Duration;

use russh::{Channel, ChannelMsg};
use sevenshell_error::ShellError;
use tokio::time::Instant;

use crate::SshSession;
use crate::session::close_channel_quietly;

/// How much output one command may produce before it is stopped.
///
/// Not a policy about what people may run: it is the difference between a command that printed too
/// much and a process that is holding a connection open until somebody notices.
pub const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

/// What a command did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecOutcome {
    pub stdout: String,
    pub stderr: String,
    /// The exit status the server reported, when it reported one. A command killed by a signal, or
    /// a connection that ended first, leaves this empty — which is not the same as a failure, and
    /// is why it is an `Option` rather than a zero.
    pub exit_code: Option<u32>,
    /// How long it took, measured here.
    pub duration: Duration,
}

impl ExecOutcome {
    /// Whether the command reported success. A missing status is not success.
    pub fn succeeded(&self) -> bool {
        self.exit_code == Some(0)
    }
}

/// What a command said, when the caller set its own output ceiling.
///
/// No marker is appended for truncated output: a caller with a small ceiling is reading the text as
/// data (completion candidates, for instance), and a sentence about truncation would become a
/// candidate of its own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecCapture {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<u32>,
    pub duration: Duration,
    pub truncated: bool,
}

impl SshSession {
    /// Runs one command and waits for it to finish.
    ///
    /// The timeout covers the whole command, because a command that never returns is the failure
    /// this exists to prevent; the connection is left open afterwards, so one connection can run
    /// several commands in a row.
    pub async fn exec(&self, command: &str, timeout: Duration) -> Result<ExecOutcome, ShellError> {
        let captured = self.exec_capture(command, timeout, MAX_OUTPUT_BYTES).await?;
        Ok(ExecOutcome {
            stdout: as_text(captured.stdout, captured.truncated),
            stderr: as_text(captured.stderr, captured.truncated),
            exit_code: captured.exit_code,
            duration: captured.duration,
        })
    }

    /// Runs one command with a caller-supplied output ceiling.
    ///
    /// The ceiling is checked as the streams arrive rather than after they have been collected: a
    /// caller that asks for a completion's worth of text must not pay for megabytes first.
    ///
    /// The channel is this side's to close whenever the read ends without the server having said
    /// Close itself. This is the path every monitor sample, probe and completion read takes, and
    /// a channel abandoned on a timeout would keep its session slot on the server until the whole
    /// connection dies — the way a sampling loop fills a server's `MaxSessions`.
    pub async fn exec_capture(
        &self,
        command: &str,
        timeout: Duration,
        max_output_bytes: usize,
    ) -> Result<ExecCapture, ShellError> {
        let started = Instant::now();
        let mut channel = self.open_command_channel().await?;

        if let Err(error) = channel.exec(true, command.to_owned()).await {
            let error = self.channel_failure(&format!("`{command}` could not be started"), &error);
            close_channel_quietly(&mut channel).await;
            return Err(error);
        }

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_code = None;
        let mut truncated = false;
        // Set only when the server said Close itself: the one end of this read that leaves no
        // channel behind.
        let mut server_closed = false;

        let collect = async {
            // Read until the channel closes. An `Eof` arrives before the exit status often enough
            // that stopping there would lose the status, which is the part the caller needs.
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    // Stream 1 is stderr; the others are nothing this talks to.
                    ChannelMsg::ExtendedData { data, ext: 1 } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                    ChannelMsg::Close => {
                        server_closed = true;
                        break;
                    }
                    _ => {}
                }

                if stdout.len() + stderr.len() > max_output_bytes {
                    truncated = true;
                    break;
                }
            }
        };

        let timed_out = tokio::time::timeout(timeout, collect).await.is_err();

        if !server_closed {
            // A timeout leaves the command running on the far side, and a full ceiling leaves it
            // mid-write. The channel is closed rather than abandoned so the server's session slot
            // goes with it.
            close_channel_quietly(&mut channel).await;
        }

        if timed_out {
            // The channel has been told Close above; the command's outcome is a timeout, because
            // whatever is running on the other side is not going to answer, and waiting for it is
            // what the timeout is for.
            return Err(ShellError::ssh_timeout(&self.host, self.port, whole_seconds(timeout)));
        }

        Ok(ExecCapture {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code,
            duration: started.elapsed(),
            truncated,
        })
    }

    /// Opens a channel for a command, which is a session channel with nothing requested on it yet.
    async fn open_command_channel(&self) -> Result<Channel<russh::client::Msg>, ShellError> {
        self.open_session_channel_for("a command").await
    }
}

/// Decodes output as text, replacing anything that is not.
///
/// A command's output is bytes, and some of those bytes are not text: a `cat` of a binary file, a
/// locale the server does not have. Showing replacement characters is better than refusing to show
/// the output at all, and it says the same thing the person would see in a terminal.
fn as_text(text: String, truncated: bool) -> String {
    let mut text = text;
    if truncated {
        text.push_str("\n… output was cut off: the command produced more than this will keep\n");
    }
    text
}

/// Rounds a duration up to whole seconds, and never says zero.
///
/// A timeout of "0 seconds" reads like no timeout at all, which is the opposite of what happened.
pub(crate) fn whole_seconds(duration: Duration) -> u64 {
    duration.as_secs().max(1)
}
