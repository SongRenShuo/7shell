//! The process page's write: ending one process on the far side.
//!
//! A thin adapter like every command here — the gate, the fixed command and the audit line all
//! live in the core (`crates/sevenshell-core/src/process.rs`), which is also where the reading of
//! a missing exit status is written down.

use sevenshell_error::ShellError;
use tauri::State;

use crate::state::ShellState;

/// Ends one process after the core's policy gate has decided about it.
#[tauri::command]
pub async fn process_kill(
    state: State<'_, ShellState>,
    session_id: String,
    handle: String,
    pid: u32,
    acknowledged: bool,
) -> Result<(), ShellError> {
    state
        .core()
        .kill_process(&session_id, &handle, pid, acknowledged)
        .await
}
