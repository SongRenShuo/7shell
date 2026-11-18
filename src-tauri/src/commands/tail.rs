//! The file-tail command surface.
//!
//! A followed file is a stream that outlives its call: the open answers a tail id and delivers
//! lines as `tail_line` / `tail_end` events, which is the same envelope a container log's
//! `container:stream` rides — one event per line, then the end after them.

use sevenshell_error::ShellError;
use sevenshell_types::{TailStreamEnd, TailStreamLine};
use tauri::{AppHandle, Emitter as _, State};
use tokio::sync::mpsc::UnboundedReceiver;

use crate::state::ShellState;

/// Follows a file on the far side of a session, and answers the tail id the window keeps.
#[tauri::command]
pub async fn file_tail_open(
    app: AppHandle,
    state: State<'_, ShellState>,
    session_id: String,
    path: String,
    lines: u32,
) -> Result<String, ShellError> {
    let (events, tail_lines) = tokio::sync::mpsc::unbounded_channel();
    let (end, ends) = tokio::sync::mpsc::unbounded_channel();
    let tail_id = state
        .core()
        .file_tail_open(&session_id, &path, lines, events, end)
        .await?;
    forward_tail_stream(app, tail_lines, ends);
    Ok(tail_id)
}

/// Stops one tail. Asking to stop a tail that is already gone is not a failure.
#[tauri::command]
pub async fn file_tail_close(state: State<'_, ShellState>, tail_id: String) -> Result<(), ShellError> {
    state.core().file_tail_close(&tail_id).await
}

/// Delivers a tail's lines to the window, and its end after them.
fn forward_tail_stream(
    app: AppHandle,
    mut lines: UnboundedReceiver<TailStreamLine>,
    mut end: UnboundedReceiver<TailStreamEnd>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                Some(line) = lines.recv() => {
                    if let Err(error) = app.emit("tail_line", line) {
                        log::warn!("a tail line could not be delivered: {error}");
                    }
                }
                Some(finished) = end.recv() => {
                    // Lines already queued are delivered before the end: telling the interface the
                    // tail is over while the last line is still on its way would cut the file's
                    // last words off.
                    while let Ok(line) = lines.try_recv() {
                        if let Err(error) = app.emit("tail_line", line) {
                            log::warn!("a tail line could not be delivered: {error}");
                        }
                    }
                    if let Err(error) = app.emit("tail_end", finished) {
                        log::warn!("a tail end could not be delivered: {error}");
                    }
                    break;
                }
            }
        }
    });
}
