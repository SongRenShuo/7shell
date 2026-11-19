//! The Compose project command surface.
//!
//! Reading verbs answer rows; the verbs that change a project are decided below this line, before
//! the engine is even looked up. The one verb that touches the host's disk — the Compose file —
//! goes through the session's file channel in the core, with the path as the policy sees it.

use sevenshell_error::ShellError;
use sevenshell_types::{ComposeProject, ComposeServiceRow};
use tauri::{AppHandle, State};

use crate::commands::container::forward_stream;
use crate::state::ShellState;

#[tauri::command]
pub async fn compose_ls(
    state: State<'_, ShellState>,
    connection_id: String,
) -> Result<Vec<ComposeProject>, ShellError> {
    state.core().compose_ls(&connection_id).await
}

#[tauri::command]
pub async fn compose_ps(
    state: State<'_, ShellState>,
    connection_id: String,
    name: String,
) -> Result<Vec<ComposeServiceRow>, ShellError> {
    state.core().compose_ps(&connection_id, &name).await
}

/// Brings one project up. Detached answers `None` when the containers have started; attached
/// answers a stream id whose lines arrive on the container stream channel.
#[tauri::command]
pub async fn compose_up(
    app: AppHandle,
    state: State<'_, ShellState>,
    connection_id: String,
    name: String,
    yml_path: String,
    detach: bool,
) -> Result<Option<String>, ShellError> {
    let (events, lines) = tokio::sync::mpsc::unbounded_channel();
    let (end, ends) = tokio::sync::mpsc::unbounded_channel();
    let stream = state
        .core()
        .compose_up_start(&connection_id, &name, &yml_path, detach, events, end)
        .await?;
    if stream.is_some() {
        forward_stream(app, lines, ends);
    }
    Ok(stream)
}

#[tauri::command]
pub async fn compose_down(state: State<'_, ShellState>, connection_id: String, name: String) -> Result<(), ShellError> {
    state.core().compose_down(&connection_id, &name).await
}

#[tauri::command]
pub async fn compose_restart(
    state: State<'_, ShellState>,
    connection_id: String,
    name: String,
) -> Result<(), ShellError> {
    state.core().compose_restart(&connection_id, &name).await
}

#[tauri::command]
pub async fn compose_logs_start(
    app: AppHandle,
    state: State<'_, ShellState>,
    connection_id: String,
    name: String,
    tail: u32,
) -> Result<String, ShellError> {
    let (events, lines) = tokio::sync::mpsc::unbounded_channel();
    let (end, ends) = tokio::sync::mpsc::unbounded_channel();
    let stream_id = state
        .core()
        .compose_logs_start(&connection_id, &name, tail, events, end)
        .await?;
    forward_stream(app, lines, ends);
    Ok(stream_id)
}

/// Writes the Compose file to the path the interface chose, through the session's file channel.
#[tauri::command]
pub async fn compose_write_yaml(
    state: State<'_, ShellState>,
    connection_id: String,
    yml_path: String,
    yml: String,
) -> Result<(), ShellError> {
    state.core().compose_write_yaml(&connection_id, &yml_path, &yml).await
}
