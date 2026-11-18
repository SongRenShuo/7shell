//! The trash's wire shapes.
//!
//! Everything here is answered by reading the remote machine's freedesktop trash through the file
//! browser's SFTP channel, so the types say what a person sees: an entry as it sits in the trash
//! (with its original path when the trashinfo beside it could be read), what one move or restore
//! did per path, and how much an empty removed.

use serde::{Deserialize, Serialize};

/// One entry in the remote trash.
///
/// `id` is the name the entry carries inside `Trash/files`, and it is what every operation that
/// acts on one entry names. `originalPath` is absent when no trashinfo could be paired with the
/// entry — or when the one there could not be trusted — and such an entry can be removed but not
/// restored: where it came from is nobody's guess to make.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub id: String,
    /// The name drawn in the list. The same as `id` today, kept apart because the id is an address
    /// and the name is a label.
    pub name: String,
    /// Where the entry lived before it was deleted, when the trashinfo said so and the path passed
    /// the safety checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    /// Seconds since the Unix epoch, when the trashinfo's deletion date could be read. Dates in a
    /// trashinfo carry no zone, so they are read as UTC — a timestamp shown an hour or two off is
    /// better than one not shown at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
    pub is_dir: bool,
    /// Bytes, for a file the server sized. Absent for a directory: a folder's size is the sum of a
    /// walk this surface does not take.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// One request line of a delete that should land in the trash: the path as the browser listed it,
/// and whether it is a folder, which decides how the move back out would have to work.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashMoveRequest {
    pub path: String,
    pub is_dir: bool,
}

/// What became of one path a delete sent to the trash.
///
/// A batch reports per item rather than stopping at the first, the way a paste does: a move that
/// failed because the path lives on another filesystem is one row's failure, and the rows that
/// could be moved have been moved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashMoveOutcome {
    pub path: String,
    /// Whether the path is now in the trash.
    pub ok: bool,
    /// Where it sits now, when the move worked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trash_path: Option<String>,
    /// Why this one failed, when it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Whether the trash was emptied, and what it held.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEmptyOutcome {
    pub removed: u64,
}
