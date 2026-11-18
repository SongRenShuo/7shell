//! The trash's commands: the file browser's delete that lands in the trash, and the browser over
//! the trash itself.
//!
//! Every one of these rides the file browser the handle names — the trash has no channel of its
//! own — and the two verbs that destroy carry an acknowledgement, because the policy gate asks
//! before it answers anything else.

use sevenshell_error::ShellError;
use sevenshell_types::{TrashEmptyOutcome, TrashEntry, TrashMoveOutcome, TrashMoveRequest};
use tauri::State;

use crate::state::ShellState;

/// Lists the remote trash: one line per entry, with its original path when a sidecar proves one.
#[tauri::command]
pub async fn trash_list(state: State<'_, ShellState>, handle: String) -> Result<Vec<TrashEntry>, ShellError> {
    state.core().trash_list(&handle).await
}

/// Moves one entry back out of the trash, answering where it landed.
#[tauri::command]
pub async fn trash_restore(
    state: State<'_, ShellState>,
    handle: String,
    id: String,
) -> Result<String, ShellError> {
    state.core().trash_restore(&handle, &id).await
}

/// Deletes one entry from the trash for good, after the policy gate has asked about it.
#[tauri::command]
pub async fn trash_remove(
    state: State<'_, ShellState>,
    session_id: String,
    handle: String,
    id: String,
    acknowledged: bool,
) -> Result<(), ShellError> {
    state
        .core()
        .trash_remove(&session_id, &handle, &id, acknowledged)
        .await
}

/// Empties the trash, after the policy gate has asked about it.
#[tauri::command]
pub async fn trash_empty(
    state: State<'_, ShellState>,
    session_id: String,
    handle: String,
    acknowledged: bool,
) -> Result<TrashEmptyOutcome, ShellError> {
    state
        .core()
        .trash_empty(&session_id, &handle, acknowledged)
        .await
}

/// Moves paths into the trash instead of deleting them: the delete mode "trash" is this.
#[tauri::command]
pub async fn trash_move(
    state: State<'_, ShellState>,
    handle: String,
    entries: Vec<TrashMoveRequest>,
) -> Result<Vec<TrashMoveOutcome>, ShellError> {
    state.core().move_to_trash(&handle, &entries).await
}
