//! The system panel's two reads: everything the machine says about itself, and the journal tail.
//!
//! Both are thin adapters over the core, which is where the fixed commands and their parsing
//! live. Nothing here takes a value a person typed: the panel's journal size is a number the
//! shell clamps before it reaches a command.

use sevenshell_error::ShellError;
use sevenshell_types::{JournalTail, SystemOverview};
use tauri::State;

use crate::state::ShellState;

/// One read of the machine: services, disks, accounts, networking, and the facts above them.
#[tauri::command]
pub async fn system_overview(state: State<'_, ShellState>, handle: String) -> Result<SystemOverview, ShellError> {
    state.core().system_overview(&handle).await
}

/// Starts, restarts or stops one service, after the core's policy gate decided about it.
#[tauri::command]
pub async fn system_service_action(
    state: State<'_, ShellState>,
    session_id: String,
    handle: String,
    unit: String,
    verb: String,
    acknowledged: bool,
) -> Result<(), ShellError> {
    state
        .core()
        .service_action(&session_id, &handle, &unit, &verb, acknowledged)
        .await
}

/// The journal's tail, cut to the number asked for.
#[tauri::command]
pub async fn system_journal(
    state: State<'_, ShellState>,
    handle: String,
    lines: u32,
) -> Result<JournalTail, ShellError> {
    state.core().journal_tail(&handle, lines as usize).await
}
