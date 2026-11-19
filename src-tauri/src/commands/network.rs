//! The network command surface of a desktop's Docker engine.
//!
//! A thin adapter over the core, like the container surface beside it: the removal guardrail and
//! the policy verdict live below this line, so what arrives here is only the arguments.

use sevenshell_error::ShellError;
use sevenshell_types::{NetworkCreateRequest, NetworkSummary};
use tauri::State;

use crate::state::ShellState;

#[tauri::command]
pub async fn network_list(
    state: State<'_, ShellState>,
    connection_id: String,
) -> Result<Vec<NetworkSummary>, ShellError> {
    state.core().network_list(&connection_id).await
}

#[tauri::command]
pub async fn network_create(
    state: State<'_, ShellState>,
    connection_id: String,
    request: NetworkCreateRequest,
) -> Result<(), ShellError> {
    state.core().network_create(&connection_id, &request).await
}

/// Removes one network. A network the engine says is still in use is refused below this line with
/// its own code; the interface only shows it.
#[tauri::command]
pub async fn network_remove(
    state: State<'_, ShellState>,
    connection_id: String,
    name: String,
) -> Result<(), ShellError> {
    state.core().network_remove(&connection_id, &name).await
}
