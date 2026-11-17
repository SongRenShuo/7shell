//! The desktop workbench's command: the one action on this surface that reaches the far side.
//!
//! Everything else the workbench shows arrives through the commands it already has — the system
//! mark, the monitor sample, the file browser. This module exists so the power action's
//! acknowledgement travels through the same thin adapter every other gated action does.

use sevenshell_error::ShellError;
use sevenshell_types::WorkbenchPowerOutcome;
use tauri::State;

use crate::state::ShellState;

/// Runs one workbench power action after the core's policy gate has decided about it.
#[tauri::command]
pub async fn workbench_power(
    state: State<'_, ShellState>,
    session_id: String,
    handle: String,
    action: String,
    acknowledged: bool,
) -> Result<WorkbenchPowerOutcome, ShellError> {
    state
        .core()
        .workbench_power(&session_id, &handle, &action, acknowledged)
        .await
}
