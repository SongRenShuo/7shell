//! Remote desktops: handed to the system client on Windows, or to the system browser on demand.
//!
//! The protocol does not live in this process; `Core::open_desktop` writes a temporary `.rdp` file
//! and starts the Windows client. Nothing pixel-shaped crosses this command surface.

use sevenshell_error::ShellError;
use tauri::State;

use crate::state::ShellState;

#[tauri::command]
pub async fn desktop_open(state: State<'_, ShellState>, session_id: String) -> Result<(), ShellError> {
    state.core().open_desktop(&session_id).await
}

/// Hands one desktop session to the system browser: the embedded host starts (or is reused), the
/// URL is built with the deep link, and the system's own way of opening a URL does the rest.
///
/// The URL comes back so the interface can put it where a person can copy it again. A session the
/// vault does not know is refused before anything starts, so a stale tab or a mistyped id never
/// costs a listener.
#[tauri::command]
pub async fn desktop_browser_open(state: State<'_, ShellState>, session_id: String) -> Result<String, ShellError> {
    let url = state.webhost().url_for(&session_id).await?;
    crate::reveal::open_url(&url)?;
    Ok(url)
}

/// The same URL without opening anything: the stub card's copy action takes it, and so does the
/// end-to-end suite, which drives a browser of its own.
#[tauri::command]
pub async fn desktop_browser_url(state: State<'_, ShellState>, session_id: String) -> Result<String, ShellError> {
    state.webhost().url_for(&session_id).await
}
