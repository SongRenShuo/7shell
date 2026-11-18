//! The remote trash: the freedesktop `~/.local/share/Trash`, over the file browser's channel.
//!
//! Deleting into the trash is a move plus a small sidecar: the entry is renamed into `Trash/files`
//! under a name that is not taken, and `Trash/info/<name>.trashinfo` records where it came from and
//! when. Listing pairs the two halves up; restoring reads the sidecar and moves the entry back; the
//! rest is deletion with the sidecar taken along. Nothing here runs a command on the far side —
//! every step is an SFTP file operation, which is why the trash only exists for an SFTP browser and
//! why everything in this module is bounded by what SFTP can do (a same-filesystem rename; there is
//! no server-side copy to fall back on).
//!
//! The trashinfo file is *other people's data*: it was written by gio, by another tool, or by
//! whoever had the file open, and its `Path` line is read here as hostile input. A path that
//! carries `..`, control characters, or anything else a container-file path would be refused for
//! leaves the entry listed but unrestoreable — an entry whose origin cannot be proven is not one
//! this side may move back out onto the filesystem.

use std::sync::Arc;

use sevenshell_error::{ErrorCode, ShellError};
use sevenshell_sftp::SftpSession;
use sevenshell_types::{EntryKind, PolicyAction, TrashEmptyOutcome, TrashEntry, TrashMoveOutcome, TrashMoveRequest};

use crate::sessions::{Core, now_seconds};

/// The trash lives at a fixed place under the home directory the SFTP channel opens in.
const TRASH_DIR: &str = ".local/share/Trash";
const FILES_SUBDIR: &str = "files";
const INFO_SUBDIR: &str = "info";
const INFO_SUFFIX: &str = ".trashinfo";
/// The first line of a trashinfo file, as the freedesktop spec spells it (with the space).
const TRASH_INFO_HEADER: &str = "[Trash Info]";

/// A name inside `Trash/files` is an address, and it is read back out of listings that were written
/// by other tools: keep it to one path component and a length a filesystem actually allows.
const ENTRY_ID_MAX_CHARS: usize = 255;
/// A restore target comes from a trashinfo line, so it is bounded like any other remote path this
/// side is asked to act on.
const ORIGINAL_PATH_MAX_CHARS: usize = 4096;

impl Core {
    /// Lists the trash: one line per entry in `Trash/files`, paired with its trashinfo when there
    /// is one that can be read and trusted.
    ///
    /// A trash that has never been used has no `files` directory, and that is an empty trash rather
    /// than an error — the answer to "what is in there" before anything was ever deleted is "nothing".
    pub async fn trash_list(&self, handle: &str) -> Result<Vec<TrashEntry>, ShellError> {
        let files = self.trash_channel(handle).await?;
        let (files_dir, info_dir) = trash_dirs(&files).await;

        let listing = match files.list(&files_dir).await {
            Ok(listing) => listing,
            Err(error) if error.code() == ErrorCode::SftpNotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };

        let mut entries = Vec::with_capacity(listing.entries.len());
        for item in listing.entries {
            let info_path = remote_join(&info_dir, &format!("{}{INFO_SUFFIX}", item.name));
            let sidecar = match files.read_text(&info_path).await {
                Ok(text) => parse_trashinfo(&text),
                // No sidecar, no origin: the entry is listed and can be removed, but nothing may
                // be guessed about where it came from.
                Err(error) if error.code() == ErrorCode::SftpNotFound => ParsedTrashInfo::missing(),
                Err(error) => return Err(error),
            };
            let original_path = sidecar.path.as_deref().and_then(sanitize_original_path);
            entries.push(TrashEntry {
                id: item.name.clone(),
                name: item.name,
                original_path,
                deleted_at: sidecar.deleted_at,
                is_dir: item.kind == EntryKind::Directory,
                size: (item.kind != EntryKind::Directory).then_some(item.size),
            });
        }
        Ok(entries)
    }

    /// Moves one entry back out of the trash, to where its trashinfo says it came from.
    ///
    /// The restored path is the answer, because it may not be the path the trashinfo recorded: a
    /// name that is taken now is not overwritten — the entry lands beside it with a timestamp
    /// suffix, the same rule the move into the trash follows in reverse. A rename across
    /// filesystems is something SFTP cannot do, and the error says so rather than falling back to a
    /// byte-by-byte copy that would silently drop a directory's permissions.
    pub async fn trash_restore(&self, handle: &str, id: &str) -> Result<String, ShellError> {
        check_entry_id(id)?;

        let files = self.trash_channel(handle).await?;
        let (files_dir, info_dir) = trash_dirs(&files).await;
        let entry_path = remote_join(&files_dir, id);
        let info_path = remote_join(&info_dir, &format!("{id}{INFO_SUFFIX}"));

        let text = files
            .read_text(&info_path)
            .await
            .map_err(|_| ShellError::trash_entry_not_found(id))?;
        let sidecar = parse_trashinfo(&text);
        let original = sidecar
            .path
            .as_deref()
            .and_then(sanitize_original_path)
            .ok_or_else(|| {
                ShellError::trash_operation_failed(
                    id,
                    "the trashinfo beside this entry does not name a usable original path",
                )
            })?;

        let target = free_target_name(&files, &original, sidecar.deleted_at).await?;
        files.rename(&entry_path, &target).await.map_err(|error| {
            ShellError::trash_operation_failed(
                id,
                format!(
                    "{error}. A rename can only stay on one filesystem; an entry whose original path \
                     lives on another one cannot be restored over SFTP."
                ),
            )
        })?;

        // The sidecar has said its piece. Leaving it behind would pair it with the next entry that
        // takes this name in the trash, which would be a lie with worse consequences.
        remove_info_quietly(&files, &info_path).await;
        Ok(target)
    }

    /// Deletes one entry from the trash for good, sidecar and all.
    ///
    /// The gate runs before the handle is looked up, on the session the caller named: a `Deny` is
    /// an answer about the machine, not about whether a channel happens to be open.
    pub async fn trash_remove(&self, session_id: &str, handle: &str, id: &str, acknowledged: bool) -> Result<(), ShellError> {
        check_entry_id(id)?;
        trash_gate(self, session_id, "remove", acknowledged)?;

        let files = self.trash_channel(handle).await?;
        let (files_dir, info_dir) = trash_dirs(&files).await;
        let entry_path = remote_join(&files_dir, id);
        if !files.exists(&entry_path).await? {
            return Err(ShellError::trash_entry_not_found(id));
        }
        files.remove_path(&entry_path).await?;
        remove_info_quietly(&files, &remote_join(&info_dir, &format!("{id}{INFO_SUFFIX}"))).await;
        Ok(())
    }

    /// Empties the trash, after the policy gate has decided about it.
    ///
    /// Every entry in `files` goes, paired or not — an entry whose origin is unknown is exactly the
    /// one somebody asking for an empty means to be rid of — and then every `.trashinfo` in `info`
    /// goes with them. The count is what was actually removed, which a listing read earlier could
    /// only have promised.
    pub async fn trash_empty(
        &self,
        session_id: &str,
        handle: &str,
        acknowledged: bool,
    ) -> Result<TrashEmptyOutcome, ShellError> {
        trash_gate(self, session_id, "empty", acknowledged)?;

        let files = self.trash_channel(handle).await?;
        let (files_dir, info_dir) = trash_dirs(&files).await;

        let mut removed = 0u64;
        if let Ok(listing) = files.list(&files_dir).await {
            for item in listing.entries {
                files.remove_path(&item.path).await?;
                removed += 1;
            }
        }
        if let Ok(listing) = files.list(&info_dir).await {
            for item in listing.entries {
                // A name that is not a sidecar is not one this verb was asked about; `info` is
                // shared convention, and a stranger's file there is left where it was.
                if item.name.ends_with(INFO_SUFFIX) {
                    files.remove_path(&item.path).await?;
                }
            }
        }
        Ok(TrashEmptyOutcome { removed })
    }

    /// Moves paths into the trash instead of deleting them: the file browser's "delete" when the
    /// delete mode is set to trash.
    ///
    /// Every path is answered on its own, because one path on another filesystem fails a rename
    /// that the rest do not need to be dragged down by. The trashinfo is written after the move and
    /// the move is undone if the write fails: an entry that landed in the trash without its sidecar
    /// could never be restored, and silently keeping it would be a delete that lied about being
    /// reversible.
    pub async fn move_to_trash(
        &self,
        handle: &str,
        requests: &[TrashMoveRequest],
    ) -> Result<Vec<TrashMoveOutcome>, ShellError> {
        let files = self.trash_channel(handle).await?;
        let (files_dir, info_dir) = trash_dirs(&files).await;
        ensure_trash_dirs(&files, &files_dir, &info_dir).await?;

        let mut outcomes = Vec::with_capacity(requests.len());
        for request in requests {
            outcomes.push(trash_one(&files, &files_dir, &info_dir, request).await);
        }
        Ok(outcomes)
    }

    /// The SFTP channel a trash operation rides, which is the file browser's own.
    ///
    /// Only an SFTP browser carries a trash: the semantics are a set of renames and reads over the
    /// protocol, and a WebDAV folder or a container has neither a home directory on the far side
    /// nor a rename that says what it refused. `sftp` answers `APP-UNSUPPORTED` for every other
    /// backend, and that refusal travels as it is.
    async fn trash_channel(&self, handle: &str) -> Result<Arc<SftpSession>, ShellError> {
        let browser = self.file_session(handle).await?;
        Ok(browser.sftp()?.clone())
    }
}

/// The destructive gate the trash verbs share, in the workbench gate's order: the verb is judged
/// and the decision is on the trail before any handle is looked up.
fn trash_gate(core: &Core, session_id: &str, verb: &str, acknowledged: bool) -> Result<(), ShellError> {
    let action = format!("trash.{verb}");
    let verdict = sevenshell_policy::trash_action(verb);
    let saved = core.session_policy_target(session_id);
    let target = saved.as_ref().map(|saved| saved.as_target()).unwrap_or_default();
    let decision = core.policy_decision(&action, &verdict, target, Some(session_id), Some(verb));
    match decision.action {
        PolicyAction::Deny => Err(ShellError::policy_denied(&action)),
        PolicyAction::Ask if !acknowledged => {
            let rule = verdict
                .reasons
                .first()
                .map(|reason| reason.rule_id.as_str())
                .unwrap_or("trash.unknown");
            Err(ShellError::policy_approval_required(rule))
        }
        _ => Ok(()),
    }
}

/// The pair of directories everything in this module works through, under the channel's home.
async fn trash_dirs(files: &Arc<SftpSession>) -> (String, String) {
    let home = files.resolve(".").await;
    let trash = remote_join(&home, TRASH_DIR);
    (
        remote_join(&trash, FILES_SUBDIR),
        remote_join(&trash, INFO_SUBDIR),
    )
}

/// Creates `files` and `info` when neither is there. A trash that has never been used has neither;
/// a delete is the first thing that can make them.
async fn ensure_trash_dirs(files: &Arc<SftpSession>, files_dir: &str, info_dir: &str) -> Result<(), ShellError> {
    for directory in [files_dir, info_dir] {
        if !files.exists(directory).await? {
            files.create_dir(directory).await?;
        }
    }
    Ok(())
}

/// Moves one path into the trash and writes its sidecar, answering what became of it.
async fn trash_one(files: &Arc<SftpSession>, files_dir: &str, info_dir: &str, request: &TrashMoveRequest) -> TrashMoveOutcome {
    let name = match trash_entry_name(&request.path) {
        Ok(name) => name,
        Err(error) => return refused(request, error),
    };

    // A name that is already in the trash is not overwritten — a delete that replaces something
    // previously deleted is two deletes for the price of one. The suffix is stamped from the clock
    // once and bumped per collision, so two same-named files deleted in the same second still land
    // on distinct names.
    let name = free_trash_name(files, files_dir, &name).await;
    let target = remote_join(files_dir, &name);
    if let Err(error) = files.rename(&request.path, &target).await {
        return refused(
            request,
            ShellError::trash_operation_failed(
                &request.path,
                format!(
                    "{error}. A rename can only stay on one filesystem; a path that lives on another \
                     one has to be deleted directly."
                ),
            ),
        );
    }

    let sidecar_path = remote_join(info_dir, &format!("{name}{INFO_SUFFIX}"));
    let sidecar = format!(
        "{TRASH_INFO_HEADER}\nPath={}\nDeletionDate={}\n",
        encode_trashinfo_path(&request.path),
        format_timestamp(now_seconds())
    );
    if let Err(error) = files.write_text(&sidecar_path, &sidecar).await {
        // Undo the move where it can be undone; where it cannot, say so — the entry is now an
        // unrestoreable one in the trash, and that is a fact the row should carry.
        if let Err(back) = files.rename(&target, &request.path).await {
            log::warn!(
                "a trashinfo for {target} could not be written ({error}) and the move back failed \
                 too ({back}); the entry sits in the trash without an origin"
            );
            return refused(request, error);
        }
        return refused(request, error);
    }

    TrashMoveOutcome {
        path: request.path.clone(),
        ok: true,
        trash_path: Some(target),
        error: None,
    }
}

/// One entry of a listing that found no sidecar to pair with.
struct ParsedTrashInfo {
    path: Option<String>,
    deleted_at: Option<u64>,
}

impl ParsedTrashInfo {
    fn missing() -> Self {
        Self {
            path: None,
            deleted_at: None,
        }
    }
}

/// Reads the two lines a trashinfo carries, leniently about everything else.
///
/// A sidecar another tool wrote may carry extra fields, no deletion date, or a relative `Path` —
/// all of which parse into "not usable" rather than into an error, because a listing that failed
/// over one strange sidecar would hide every entry behind it.
fn parse_trashinfo(text: &str) -> ParsedTrashInfo {
    let mut lines = text.lines();
    let header_ok = lines.next().map(str::trim) == Some(TRASH_INFO_HEADER);
    if !header_ok {
        return ParsedTrashInfo::missing();
    }
    let mut parsed = ParsedTrashInfo::missing();
    for line in lines {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "Path" => parsed.path = Some(value.trim().to_owned()),
            "DeletionDate" => parsed.deleted_at = parse_deletion_date(value.trim()),
            _ => {}
        }
    }
    parsed
}

/// Percent-decodes a trashinfo path when it is encoded, and then judges it as a remote path.
///
/// The spec asks writers to percent-encode and gio does not bother for ordinary names, so both
/// shapes arrive here: anything that carries a valid `%XX` escape is decoded first, and a `%` that
/// starts no escape is a literal — which is also why the writer only ever encodes `%` itself, the
/// one character that would make the two shapes ambiguous.
///
/// A path that survives is absolute, free of control characters, free of `.` or `..` components,
/// and bounded in length. Anything else is `None`, and an entry whose path is `None` is one the
/// interface may list and delete but never restore.
fn sanitize_original_path(raw: &str) -> Option<String> {
    let path = percent_decode(raw);
    if path.is_empty() || !path.starts_with('/') {
        return None;
    }
    if path.chars().count() > ORIGINAL_PATH_MAX_CHARS || path.chars().any(char::is_control) {
        return None;
    }
    for component in path.split('/') {
        if component == "." || component == ".." {
            return None;
        }
    }
    Some(path)
}

/// Turns `%20` back into a space, and leaves every byte the decoder cannot honour as it was.
fn percent_decode(text: &str) -> String {
    if !text.contains('%') {
        return text.to_owned();
    }
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
        {
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).unwrap_or_else(|_| text.to_owned())
}

/// Encodes the one character that would make a stored path ambiguous, and nothing else.
///
/// gio writes ordinary names verbatim, and a reader that honours escapes reads a verbatim name
/// back verbatim; a `%` is the exception, because read as an escape it would name a different file.
fn encode_trashinfo_path(path: &str) -> String {
    path.replace('%', "%25")
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Reads the spec's local-time stamp as UTC. A stamp shown an hour or two off is better than one
/// not shown at all, and there is no timezone on the far side to ask.
fn parse_deletion_date(raw: &str) -> Option<u64> {
    let (date, time) = raw.split_once('T')?;
    let mut date = date.split('-');
    let year: i64 = date.next()?.parse().ok()?;
    let month: i64 = date.next()?.parse().ok()?;
    let day: i64 = date.next()?.parse().ok()?;
    let mut time = time.split(':');
    let hour: i64 = time.next()?.parse().ok()?;
    let minute: i64 = time.next()?.parse().ok()?;
    let second: i64 = time.next()?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let total = ((days_from_civil(year, month, day) * 24 + hour) * 60 + minute) * 60 + second;
    u64::try_from(total).ok()
}

/// Writes the stamp the spec spells, as UTC for the same reason the reader reads UTC.
fn format_timestamp(epoch: u64) -> String {
    let (date, time) = split_epoch(epoch);
    format!("{date}T{time}")
}

/// The compact spelling a collision suffix carries, so a suffix sorts beside its own day.
fn format_compact_stamp(epoch: u64) -> String {
    let (date, time) = split_epoch(epoch);
    format!("{}-{}", date.replace('-', ""), time.replace(':', ""))
}

/// The date half and the time half of an epoch, both in the spec's zero-padded spelling.
fn split_epoch(epoch: u64) -> (String, String) {
    let seconds = epoch % 86_400;
    let days = (epoch / 86_400) as i64;
    let (year, month, day) = civil_from_days(days);
    (
        format!("{year:04}-{month:02}-{day:02}"),
        format!("{:02}:{:02}:{:02}", seconds / 3600, seconds % 3600 / 60, seconds % 60),
    )
}

/// The days between 1970-01-01 and a civil date, valid for the whole range a trashinfo can name.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_shift = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_shift + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The inverse, for stamping a sidecar with today's date.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era = day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_shift = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_shift + 2) / 5 + 1;
    let month = if month_shift < 10 { month_shift + 3 } else { month_shift - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// A name inside `Trash/files`: one component, no traversal, nothing a filesystem would choke on.
fn check_entry_id(id: &str) -> Result<(), ShellError> {
    if id.is_empty() || id == "." || id == ".." || id.contains('/') || id.contains('\\') {
        return Err(ShellError::trash_operation_failed(id, "that name is not one a trash entry can carry"));
    }
    if id.chars().count() > ENTRY_ID_MAX_CHARS || id.chars().any(char::is_control) {
        return Err(ShellError::trash_operation_failed(id, "that name is not one a trash entry can carry"));
    }
    Ok(())
}

/// The last segment of a path the browser listed, refused when there is nothing sane to take.
fn trash_entry_name(path: &str) -> Result<String, ShellError> {
    let trimmed = path.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    check_entry_id(name)?;
    Ok(name.to_owned())
}

/// The first name on a base that is not taken, stamped with the clock and bumped per collision.
async fn free_trash_name(files: &Arc<SftpSession>, directory: &str, name: &str) -> String {
    let stamp = format_compact_stamp(now_seconds());
    let mut candidate = name.to_owned();
    let mut bump = 1u64;
    loop {
        let taken = match files.exists(&remote_join(directory, &candidate)).await {
            Ok(taken) => taken,
            // An existence check that failed is answered the optimistic way: the rename that
            // follows carries the real verdict, and refusing a delete over a failed probe would
            // leave the file un-deletable exactly when something is already wrong.
            Err(_) => false,
        };
        if !taken {
            return candidate;
        }
        candidate = format!("{name}.{stamp}-{bump}");
        bump += 1;
    }
}

/// `free_trash_name` for a restore, where the base is the original path and a taken name means the
/// entry lands beside what replaced it rather than on top of it.
async fn free_target_name(files: &Arc<SftpSession>, original: &str, deleted_at: Option<u64>) -> Result<String, ShellError> {
    if !files.exists(original).await? {
        return Ok(original.to_owned());
    }
    let (directory, name) = match original.rsplit_once('/') {
        Some((directory, "")) => {
            return Err(ShellError::trash_operation_failed(original, "the original path ends in a slash"));
        }
        Some((directory, name)) => (directory, name),
        None => return Err(ShellError::trash_operation_failed(original, "the original path has no name to restore")),
    };
    let stamp = format_compact_stamp(deleted_at.unwrap_or_else(now_seconds));
    let mut candidate = format!("{name}.{stamp}");
    let mut bump = 1u64;
    loop {
        let path = remote_join(directory, &candidate);
        if !files.exists(&path).await? {
            return Ok(path);
        }
        bump += 1;
        candidate = format!("{name}.{stamp}-{bump}");
    }
}

/// A sidecar that has said its piece is removed, and its absence is not news worth reporting.
async fn remove_info_quietly(files: &Arc<SftpSession>, info_path: &str) {
    if let Err(error) = files.remove_file(info_path).await
        && error.code() != ErrorCode::SftpNotFound
    {
        log::warn!("the trashinfo at {info_path} could not be removed: {error}");
    }
}

fn refused(request: &TrashMoveRequest, error: ShellError) -> TrashMoveOutcome {
    TrashMoveOutcome {
        path: request.path.clone(),
        ok: false,
        trash_path: None,
        error: Some(error.to_string()),
    }
}

/// Joins without asking the server: both sides here are paths this module built or read.
fn remote_join(directory: &str, name: &str) -> String {
    if directory.ends_with('/') {
        format!("{directory}{name}")
    } else if directory.is_empty() {
        format!("/{name}")
    } else {
        format!("{directory}/{name}")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use sevenshell_policy::{PolicyAuditEvent, PolicyJournal};
    use sevenshell_types::{PolicyAction, PolicyMatrix, PolicyRule};
    use sevenshell_vault::Vault;
    use tempfile::{TempDir, tempdir};

    use super::*;

    // -- the destructive gates ----------------------------------------------

    #[derive(Default)]
    struct RecordingJournal {
        events: Mutex<Vec<PolicyAuditEvent>>,
    }

    impl PolicyJournal for RecordingJournal {
        fn record(&self, event: PolicyAuditEvent) {
            self.events.lock().expect("not poisoned").push(event);
        }
    }

    fn deny_everything() -> PolicyRule {
        PolicyRule {
            safe: PolicyAction::Deny,
            caution: PolicyAction::Deny,
            destructive: PolicyAction::Deny,
            catastrophic: PolicyAction::Deny,
        }
    }

    fn core_with_policy(rule: PolicyRule) -> (TempDir, Arc<Core>, Arc<RecordingJournal>) {
        let directory = tempdir().expect("temp dir");
        let vault = Arc::new(Vault::open_at(directory.path().join("vault.json")));
        vault.create("correct horse battery staple").expect("create");

        let session = sevenshell_types::Session {
            id: "ssh-1".to_owned(),
            name: "a machine with a trash".to_owned(),
            group_id: None,
            protocol: sevenshell_types::Protocol::Ssh,
            host: "127.0.0.1".to_owned(),
            port: 2222,
            user: "someone".to_owned(),
            auth: sevenshell_types::SessionAuth::with_password(sevenshell_types::AuthMethod::Password),
            terminal: sevenshell_types::TerminalSettings::default(),
            desktop: sevenshell_types::DesktopSettings::default(),
            workbench: sevenshell_types::WorkbenchSettings::default(),
            telnet: sevenshell_types::TelnetSettings::default(),
            serial: sevenshell_types::SerialSettings::default(),
            local: sevenshell_types::LocalSettings::default(),
            wsl: sevenshell_types::WslSettings::default(),
            container: sevenshell_types::ContainerSettings::default(),
            kubernetes: sevenshell_types::KubernetesSettings::default(),
            webdav: sevenshell_types::WebDavSettings::default(),
            ftp: sevenshell_types::FtpSettings::default(),
            jump: Vec::new(),
            forwards: Vec::new(),
            updated_at: 0,
        };
        vault.save_session(session, None).expect("save");

        let (core, _events): (Arc<Core>, _) = Core::new(vault);
        let journal = Arc::new(RecordingJournal::default());
        core.set_policy(
            PolicyMatrix {
                global: rule,
                ..PolicyMatrix::default()
            },
            Some(Arc::clone(&journal) as Arc<dyn PolicyJournal>),
        );
        (directory, core, journal)
    }

    #[tokio::test]
    async fn a_deny_refuses_the_empty_before_any_connection_is_touched() {
        let (_directory, core, journal) = core_with_policy(deny_everything());

        // The handle names nothing real: the gate answers before the browser is looked up, so a
        // deny holds even when the channel behind it is long gone.
        let error = core
            .trash_empty("ssh-1", "handle-that-never-existed", true)
            .await
            .expect_err("a deny refuses the empty");
        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);

        let events = journal.events();
        assert_eq!(events.len(), 1, "one action, one line");
        assert_eq!(events[0].action, "trash.empty");
        assert_eq!(events[0].decision, PolicyAction::Deny);
    }

    #[tokio::test]
    async fn an_unacknowledged_remove_asks_and_nothing_is_judged_twice() {
        let (_directory, core, journal) = core_with_policy(PolicyRule::default());

        let error = core
            .trash_remove("ssh-1", "handle-that-never-existed", "notes.txt", false)
            .await
            .expect_err("a question stops the remove");
        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyApprovalRequired);

        let events = journal.events();
        assert_eq!(events.len(), 1, "one action, one line, asks included");
        assert_eq!(events[0].decision, PolicyAction::Ask);
    }

    #[tokio::test]
    async fn an_unknown_session_still_reaches_the_global_rule() {
        // No saved session carries this id, so no layers can be read; the gate falls to the global
        // floor and asks there, which is the container paths' behaviour too.
        let (_directory, core, journal) = core_with_policy(PolicyRule::default());
        let error = core
            .trash_empty("session-that-never-existed", "handle-that-never-existed", false)
            .await
            .expect_err("the floor still asks");
        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyApprovalRequired);
        assert_eq!(journal.events().len(), 1);
    }

    // -- trashinfo parsing -------------------------------------------------

    #[test]
    fn a_gio_written_trashinfo_parses() {
        let parsed = parse_trashinfo("[Trash Info]\nPath=/root/trash-probe.txt\nDeletionDate=2026-11-18T08:18:07\n");
        assert_eq!(parsed.path.as_deref(), Some("/root/trash-probe.txt"));
        assert!(parsed.deleted_at.is_some(), "the deletion date is on the wire gio writes");
    }

    #[test]
    fn a_percent_encoded_path_is_decoded_and_a_literal_percent_survives() {
        let encoded = parse_trashinfo("[Trash Info]\nPath=/home/user/my%20file.txt\n");
        assert_eq!(encoded.path.as_deref(), Some("/home/user/my file.txt"));

        let literal = parse_trashinfo("[Trash Info]\nPath=/home/user/100%legit.txt\n");
        assert_eq!(literal.path.as_deref(), Some("/home/user/100%legit.txt"));
    }

    #[test]
    fn a_file_that_is_not_a_trashinfo_names_nothing() {
        assert_eq!(parse_trashinfo("").path, None);
        assert_eq!(parse_trashinfo("[Trash Info]\n").deleted_at, None);
        assert_eq!(parse_trashinfo("Path=/etc/passwd\n").path, None, "the header line is required");
    }

    #[test]
    fn a_deletion_date_that_is_not_one_is_not_one() {
        assert_eq!(parse_deletion_date("not-a-date"), None);
        assert_eq!(parse_deletion_date("2026-13-01T00:00:00"), None);
        assert_eq!(parse_deletion_date("2026-11-18"), None);
    }

    // -- hostile paths from the sidecar ------------------------------------

    #[test]
    fn traversal_and_relative_paths_are_refused() {
        assert_eq!(sanitize_original_path("/home/user/../../etc/shadow"), None);
        assert_eq!(sanitize_original_path("../escape"), None);
        assert_eq!(sanitize_original_path("relative/path"), None);
        assert_eq!(sanitize_original_path(""), None);
        assert_eq!(sanitize_original_path("/home/./user"), None);
    }

    #[test]
    fn control_characters_are_refused() {
        assert_eq!(sanitize_original_path("/home/user/\u{0}hidden"), None);
        assert_eq!(sanitize_original_path("/home/user/new\nline"), None);
    }

    #[test]
    fn an_ordinary_absolute_path_passes_unchanged() {
        assert_eq!(sanitize_original_path("/root/trash-probe.txt").as_deref(), Some("/root/trash-probe.txt"));
        assert_eq!(sanitize_original_path("/var/log/my file.log").as_deref(), Some("/var/log/my file.log"));
    }

    // -- the stamp and its inverse ------------------------------------------

    #[test]
    fn the_known_probe_timestamp_round_trips() {
        // The stamp the main lane measured on Ubuntu 22.04: 2026-11-18T08:18:07 read as UTC.
        let epoch = parse_deletion_date("2026-11-18T08:18:07").expect("parses");
        assert_eq!(format_timestamp(epoch), "2026-11-18T08:18:07");
    }

    #[test]
    fn the_epoch_boundary_stamps_as_1970() {
        assert_eq!(format_timestamp(0), "1970-01-01T00:00:00");
        assert_eq!(format_timestamp(86_399), "1970-01-01T23:59:59");
    }

    #[test]
    fn the_compact_stamp_agrees_with_the_spelled_one() {
        let epoch = parse_deletion_date("2026-11-18T08:18:07").expect("parses");
        assert_eq!(format_compact_stamp(epoch), "20261118-081807");
    }

    // -- names ---------------------------------------------------------------

    #[test]
    fn entry_ids_that_traverse_are_refused() {
        for id in ["", ".", "..", "a/b", "a\\b", "trailing\nnewline"] {
            assert!(check_entry_id(id).is_err(), "{id:?} is not a usable id");
        }
        assert!(check_entry_id("notes.txt").is_ok());
    }

    #[test]
    fn a_trash_entry_name_is_the_last_segment() {
        assert_eq!(trash_entry_name("/home/user/notes.txt").as_deref(), Some("notes.txt"));
        assert!(trash_entry_name("/").is_err(), "the root has no name to carry");
        assert_eq!(trash_entry_name("/home/user/folder/").as_deref(), Some("folder"));
    }

    #[test]
    fn the_writer_encodes_only_what_would_be_ambiguous() {
        assert_eq!(encode_trashinfo_path("/root/trash-probe.txt"), "/root/trash-probe.txt");
        assert_eq!(encode_trashinfo_path("/home/user/a%b.txt"), "/home/user/a%25b.txt");
    }
}
