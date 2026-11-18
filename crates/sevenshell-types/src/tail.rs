//! Following a file on the far side, line by line.
//!
//! The stream a followed file produces has the same two-event shape the container and cluster
//! streams have — one event per line, then one end — because the window watching the file is
//! built the same way the window watching a container's logs is, and one shape means one
//! subscription mechanism.

use serde::{Deserialize, Serialize};

/// One line a followed file produced, tagged with the tail it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailStreamLine {
    pub tail_id: String,
    pub line: String,
}

/// The last event of a followed file. `error` is present when it ended because something failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailStreamEnd {
    pub tail_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
