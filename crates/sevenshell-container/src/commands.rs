//! The argument vector each runtime's command line takes.
//!
//! Nothing here is a shell string and nothing here starts a process: a builder returns an argv for
//! the runner, or it refuses the input. Refusal happens here, before any spawn, because a container
//! name that begins with `-` would otherwise be read as an option by the runtime's own CLI, and a
//! name is whatever the far side of a connection happens to be called.
//!
//! The differences between Docker, Podman, nerdctl and WSLC live in this file and nowhere else.
//! They are not stylistic: nerdctl takes its namespace as a global flag *before* the subcommand,
//! WSLC prints `--format json` where Docker wants a Go template, WSLC has no `history` subcommand,
//! and the two runtimes that support an insecure registry express it as two different flags in
//! two different positions.

use sevenshell_error::ShellError;
use sevenshell_types::{
    ContainerCommitRequest, ContainerCreateRequest, ContainerImageTransfer, ContainerPortMapping,
    ContainerRegistryLogin, ContainerRuntime, NetworkCreateRequest,
};

/// The longest identifier (container id or name, tag, username) this build will pass on.
const MAX_IDENTIFIER_CHARS: usize = 255;
/// Docker's own limit on a reference; anything longer is refused by the CLI anyway.
const MAX_IMAGE_REFERENCE_CHARS: usize = 255;
const MAX_PLATFORM_CHARS: usize = 64;
const MAX_AUTHOR_CHARS: usize = 256;
const MAX_MESSAGE_CHARS: usize = 4096;
/// The longest remote path a compose file may be named by. A path is not an identifier: it may
/// contain almost anything, so the bound and the control-character rule are what keep it a path.
const MAX_REMOTE_PATH_CHARS: usize = 1024;

/// The template `ps` uses. `{{json .}}` is deliberately avoided: it includes `.Size`, which makes
/// the CLI ask the daemon for per-container filesystem statistics — tens of seconds on a busy host.
/// Listing the fields we draw is as fast as the table output. `.Health` renders empty for a
/// container with no healthcheck, which is how the row knows to draw no badge.
const PS_FORMAT_DOCKER: &str =
    "{{.ID}}|{{.Image}}|{{.Names}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.CreatedAt}}|{{.Health}}";
const JSON_FORMAT: &str = "{{json .}}";
/// WSLC's `--format` takes a fixed vocabulary, not a template.
const WSLC_FORMAT: &str = "json";

/// Which way an image is moving.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageTransfer {
    Pull,
    Push,
}

impl ImageTransfer {
    fn subcommand(self) -> &'static str {
        match self {
            Self::Pull => "pull",
            Self::Push => "push",
        }
    }
}

/// The runtime's name plus the flags that must precede every subcommand.
fn base(runtime: ContainerRuntime, namespace: &str) -> Vec<String> {
    let mut argv = vec![runtime.program().to_owned()];
    // nerdctl is the only runtime with namespaces, and its flag is global: after the subcommand it
    // is an error instead of an option.
    if runtime == ContainerRuntime::Nerdctl && !namespace.is_empty() {
        argv.push("--namespace".to_owned());
        argv.push(namespace.to_owned());
    }
    argv
}

fn format_flag(runtime: ContainerRuntime) -> Vec<String> {
    match runtime {
        ContainerRuntime::Docker => vec!["--format".to_owned(), PS_FORMAT_DOCKER.to_owned()],
        ContainerRuntime::Wslc => vec!["--format".to_owned(), WSLC_FORMAT.to_owned()],
        ContainerRuntime::Podman | ContainerRuntime::Nerdctl => {
            vec!["--format".to_owned(), JSON_FORMAT.to_owned()]
        }
    }
}

fn json_format_flag(runtime: ContainerRuntime) -> Vec<String> {
    match runtime {
        ContainerRuntime::Wslc => vec!["--format".to_owned(), WSLC_FORMAT.to_owned()],
        _ => vec!["--format".to_owned(), JSON_FORMAT.to_owned()],
    }
}

pub(crate) fn list(runtime: ContainerRuntime, namespace: &str) -> Vec<String> {
    let mut argv = base(runtime, namespace);
    argv.push("ps".to_owned());
    argv.push("-a".to_owned());
    argv.extend(format_flag(runtime));
    argv
}

pub(crate) fn inspect(runtime: ContainerRuntime, namespace: &str, id: &str) -> Result<Vec<String>, ShellError> {
    let id = identifier("the inspect request", "container id", id)?;
    let mut argv = base(runtime, namespace);
    argv.push("inspect".to_owned());
    argv.push(id.to_owned());
    Ok(argv)
}

pub(crate) fn logs(
    runtime: ContainerRuntime,
    namespace: &str,
    id: &str,
    tail: u32,
    follow: bool,
    timestamps: bool,
) -> Result<Vec<String>, ShellError> {
    let id = identifier("the logs request", "container id", id)?;
    let mut argv = base(runtime, namespace);
    argv.push("logs".to_owned());
    if runtime == ContainerRuntime::Wslc {
        argv.push("-n".to_owned());
        argv.push(tail.to_string());
        if follow {
            argv.push("-f".to_owned());
        }
        if timestamps {
            argv.push("-t".to_owned());
        }
    } else {
        argv.push("--tail".to_owned());
        argv.push(tail.to_string());
        if timestamps {
            argv.push("--timestamps".to_owned());
        }
        if follow {
            argv.push("-f".to_owned());
        }
    }
    argv.push(id.to_owned());
    Ok(argv)
}

pub(crate) fn stats(runtime: ContainerRuntime, namespace: &str) -> Vec<String> {
    let mut argv = base(runtime, namespace);
    argv.push("stats".to_owned());
    match runtime {
        ContainerRuntime::Wslc => argv.extend(json_format_flag(runtime)),
        _ => {
            argv.push("--no-stream".to_owned());
            argv.extend(json_format_flag(runtime));
        }
    }
    argv
}

/// The engine's own event stream, one JSON document per line, for as long as the command lives.
///
/// Nothing is filtered on the command line: every runtime spells `--filter type=container`
/// differently enough that a filter here would be three dialects to test, while the parser reads
/// the kind off each document anyway. WSLC is refused outright — its event surface was never
/// exercised, and an untested command line is refused rather than guessed at.
pub(crate) fn events(runtime: ContainerRuntime, namespace: &str) -> Result<Vec<String>, ShellError> {
    if runtime == ContainerRuntime::Wslc {
        return Err(ShellError::app_unsupported("container events on the WSLC runtime"));
    }
    let mut argv = base(runtime, namespace);
    argv.push("events".to_owned());
    argv.extend(json_format_flag(runtime));
    Ok(argv)
}

/// The one cheap, network-free probe for whether this CLI can answer an events request at all.
///
/// It answers only for the command line — that the daemon *serves* events is what the stream
/// itself finds out, and a stream that cannot open is a reconnect, not a refusal.
pub(crate) fn events_probe(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    if runtime == ContainerRuntime::Wslc {
        return Err(ShellError::app_unsupported("container events on the WSLC runtime"));
    }
    let mut argv = base(runtime, "");
    argv.push("events".to_owned());
    argv.push("--help".to_owned());
    Ok(argv)
}

/// The action verb as the runtime spells it: the interface says `remove`, the CLI says `rm`.
fn action_subcommand(runtime: ContainerRuntime, action: &str) -> Result<&'static str, ShellError> {
    let action = action.trim().to_ascii_lowercase();
    let (subcommand, supported) = match action.as_str() {
        "start" => ("start", true),
        "stop" => ("stop", true),
        "restart" => ("restart", runtime != ContainerRuntime::Wslc),
        "pause" => ("pause", runtime != ContainerRuntime::Wslc),
        "unpause" => ("unpause", runtime != ContainerRuntime::Wslc),
        "remove" | "rm" => ("rm", true),
        // `kill` is not offered. Stopping is the coarse action a person chooses from a list;
        // killing is a signal choice that belongs in the container's own terminal.
        _ => {
            return Err(ShellError::container_command_failed(
                "the action request",
                format!("unknown container action: {action}"),
            ));
        }
    };
    if !supported {
        return Err(ShellError::app_unsupported("this action on the WSLC runtime"));
    }
    Ok(subcommand)
}

pub(crate) fn action(
    runtime: ContainerRuntime,
    namespace: &str,
    action: &str,
    id: &str,
) -> Result<Vec<String>, ShellError> {
    let subcommand = action_subcommand(runtime, action)?;
    let id = identifier("the action request", "container id", id)?;
    let mut argv = base(runtime, namespace);
    argv.push(subcommand.to_owned());
    argv.push(id.to_owned());
    Ok(argv)
}

pub(crate) fn rename(
    runtime: ContainerRuntime,
    namespace: &str,
    id: &str,
    name: &str,
) -> Result<Vec<String>, ShellError> {
    if runtime == ContainerRuntime::Wslc {
        return Err(ShellError::app_unsupported("renaming a container on the WSLC runtime"));
    }
    let id = identifier("the rename request", "container id", id)?;
    let name = identifier("the rename request", "container name", name)?;
    let mut argv = base(runtime, namespace);
    argv.push("rename".to_owned());
    argv.push(id.to_owned());
    argv.push(name.to_owned());
    Ok(argv)
}

pub(crate) fn images(runtime: ContainerRuntime, namespace: &str) -> Vec<String> {
    let mut argv = base(runtime, namespace);
    argv.push("images".to_owned());
    argv.extend(json_format_flag(runtime));
    argv
}

pub(crate) fn image_inspect(
    runtime: ContainerRuntime,
    namespace: &str,
    image: &str,
) -> Result<Vec<String>, ShellError> {
    let image = image_reference("the image inspect request", image)?;
    let mut argv = base(runtime, namespace);
    argv.push("inspect".to_owned());
    argv.push(image.to_owned());
    Ok(argv)
}

/// WSLC's `--format` only accepts the word `json`, and its `image inspect` is the shape that
/// carries `RootFS.Layers`; the explicit `image` group avoids a container of the same name.
pub(crate) fn wslc_image_inspect(namespace: &str, image: &str) -> Result<Vec<String>, ShellError> {
    let image = image_reference("the image history request", image)?;
    let mut argv = base(ContainerRuntime::Wslc, namespace);
    argv.push("image".to_owned());
    argv.push("inspect".to_owned());
    argv.push("--format".to_owned());
    argv.push(WSLC_FORMAT.to_owned());
    argv.push(image.to_owned());
    Ok(argv)
}

pub(crate) fn image_history(
    runtime: ContainerRuntime,
    namespace: &str,
    image: &str,
) -> Result<Vec<String>, ShellError> {
    if runtime == ContainerRuntime::Wslc {
        return Err(ShellError::app_unsupported("image history on the WSLC runtime"));
    }
    let image = image_reference("the image history request", image)?;
    let mut argv = base(runtime, namespace);
    argv.push("history".to_owned());
    // Without it every layer's `CreatedBy` is cut at the terminal width.
    argv.push("--no-trunc".to_owned());
    argv.extend(json_format_flag(runtime));
    argv.push(image.to_owned());
    Ok(argv)
}

/// Every tag one repository has on this engine: the images listing, narrowed by the runtime's own
/// positional filter to the rows whose repository is the one asked about. A read — the drawer's
/// tags section lists what the engine holds, and the update question is `image_remote_digest`'s.
pub(crate) fn image_tags(
    runtime: ContainerRuntime,
    namespace: &str,
    repository: &str,
) -> Result<Vec<String>, ShellError> {
    let repository = image_reference("the image tags request", repository)?;
    let mut argv = base(runtime, namespace);
    argv.push("images".to_owned());
    argv.extend(json_format_flag(runtime));
    argv.push(repository.to_owned());
    Ok(argv)
}

pub(crate) fn transfer(
    runtime: ContainerRuntime,
    namespace: &str,
    direction: ImageTransfer,
    request: &ContainerImageTransfer,
) -> Result<Vec<String>, ShellError> {
    let image = image_reference("the image transfer request", &request.image)?;
    let platform = match request.platform.trim() {
        "" => None,
        value => Some(platform_value("the image transfer request", value)?),
    };

    let mut argv = base(runtime, namespace);
    // nerdctl's insecure registry is a global flag whose value is the registry host, and it has to
    // sit before the subcommand. Docker and WSLC have no per-command equivalent; the caller is
    // expected to configure the daemon there.
    if request.insecure
        && runtime == ContainerRuntime::Nerdctl
        && let Some(host) = registry_host(image)
    {
        argv.push("--insecure-registry".to_owned());
        argv.push(host.to_owned());
    }
    argv.push(direction.subcommand().to_owned());
    // WSLC's pull does not recognise `--platform`; passing it is an error, not an ignored flag.
    if let Some(platform) = platform
        && runtime != ContainerRuntime::Wslc
    {
        argv.push("--platform".to_owned());
        argv.push(platform.to_owned());
    }
    if direction == ImageTransfer::Pull && request.all_tags {
        argv.push("--all-tags".to_owned());
    }
    if request.insecure && runtime == ContainerRuntime::Podman {
        argv.push("--tls-verify=false".to_owned());
    }
    argv.push(image.to_owned());
    Ok(argv)
}

pub(crate) fn remove_image(runtime: ContainerRuntime, namespace: &str, image: &str) -> Result<Vec<String>, ShellError> {
    let image = image_reference("the image removal request", image)?;
    let mut argv = base(runtime, namespace);
    argv.push("rmi".to_owned());
    argv.push(image.to_owned());
    Ok(argv)
}

pub(crate) fn image_prune(runtime: ContainerRuntime, namespace: &str) -> Vec<String> {
    let mut argv = base(runtime, namespace);
    argv.push("image".to_owned());
    argv.push("prune".to_owned());
    // Without `-f` the CLI opens a confirmation prompt on a channel nobody is typing into.
    argv.push("-f".to_owned());
    argv
}

pub(crate) fn tag(
    runtime: ContainerRuntime,
    namespace: &str,
    image: &str,
    repository_tag: &str,
) -> Result<Vec<String>, ShellError> {
    let image = image_reference("the tag request", image)?;
    let repository_tag = image_reference("the tag request", repository_tag)?;
    let mut argv = base(runtime, namespace);
    argv.push("tag".to_owned());
    argv.push(image.to_owned());
    argv.push(repository_tag.to_owned());
    Ok(argv)
}

/// `load` reads the archive from standard input; the bytes never appear in the argv.
pub(crate) fn load(runtime: ContainerRuntime, namespace: &str) -> Vec<String> {
    let mut argv = base(runtime, namespace);
    argv.push("load".to_owned());
    argv
}

pub(crate) fn commit(
    runtime: ContainerRuntime,
    namespace: &str,
    request: &ContainerCommitRequest,
) -> Result<Vec<String>, ShellError> {
    if runtime != ContainerRuntime::Docker {
        return Err(ShellError::app_unsupported(
            "image archives and commits on this runtime",
        ));
    }
    let id = identifier("the commit request", "container id", &request.container_id)?;
    let image = image_reference("the commit request", &request.image)?;
    let author = free_text("the commit request", "author", &request.author, MAX_AUTHOR_CHARS)?;
    let message = free_text("the commit request", "message", &request.message, MAX_MESSAGE_CHARS)?;

    let mut argv = base(runtime, namespace);
    argv.push("commit".to_owned());
    if let Some(author) = author {
        argv.push("--author".to_owned());
        argv.push(author.to_owned());
    }
    if let Some(message) = message {
        argv.push("--message".to_owned());
        argv.push(message.to_owned());
    }
    argv.push(id.to_owned());
    argv.push(image.to_owned());
    Ok(argv)
}

/// The password never appears here: the caller feeds it to `--password-stdin`.
pub(crate) fn login(runtime: ContainerRuntime, login: &ContainerRegistryLogin) -> Result<Vec<String>, ShellError> {
    let username = identifier("the login request", "username", &login.username)?;
    let registry = match login.registry.trim() {
        "" => None,
        value => Some(registry_address("the login request", value)?),
    };

    let mut argv = vec![runtime.program().to_owned()];
    if login.insecure
        && runtime == ContainerRuntime::Nerdctl
        && let Some(registry) = registry
    {
        argv.push("--insecure-registry".to_owned());
        argv.push(registry.to_owned());
    }
    argv.push("login".to_owned());
    argv.push("--password-stdin".to_owned());
    argv.push("-u".to_owned());
    argv.push(username.to_owned());
    if login.insecure && runtime == ContainerRuntime::Podman {
        argv.push("--tls-verify=false".to_owned());
    }
    if let Some(registry) = registry {
        argv.push(registry.to_owned());
    }
    Ok(argv)
}

/// Listing namespaces is itself a nerdctl command and takes no namespace: it is how you find out
/// which ones exist.
pub(crate) fn namespaces(runtime: ContainerRuntime) -> Vec<String> {
    vec![runtime.program().to_owned(), "namespace".to_owned(), "ls".to_owned()]
}

/// Whether this command line only asks and can be asked again as it is.
///
/// A read that ends without an exit status — a channel that closed before the server said how the
/// command did — is the one failure a second identical attempt is safe for. Anything that changes
/// the engine is not: the first run may have taken effect, and repeating it is a decision nobody
/// made. The verdict is read off the argv, the place every verb this module builds is spelled; a
/// verb that is not on the list reads as "may not repeat", which is the safe default.
///
/// Three argv shapes carry a flag in front of the verb, and all three are built here: nerdctl's
/// `--namespace`, compose's `--project-name`, and compose's `--file`. The skip stops at the first
/// word that is not one of them, so the verb of a shape this module never produced reads as "may
/// not repeat" too.
pub(crate) fn is_idempotent_read(argv: &[String]) -> bool {
    let mut index = 1;
    if argv.is_empty() {
        return false;
    }
    while matches!(
        argv.get(index).map(String::as_str),
        Some("--namespace" | "--project-name" | "--file")
    ) {
        index += 2;
    }
    let verb = argv.get(index).map(String::as_str);
    let operand = argv.get(index + 1).map(String::as_str);
    match (verb, operand) {
        (Some("ps" | "inspect" | "images" | "history" | "info" | "version" | "stats"), ..) => true,
        (Some("namespace"), Some("ls")) => true,
        (Some("network"), Some("ls" | "inspect")) => true,
        (Some("volume"), Some("ls")) => true,
        (Some("system"), Some("df")) => true,
        (Some("buildx"), Some("version" | "imagetools")) => true,
        (Some("manifest"), Some("inspect")) => true,
        // Only the capability probe runs as a command; the real events follow is a stream, which
        // never goes through a runner that could repeat it.
        (Some("events"), _) => argv.iter().any(|word| word == "--help"),
        // The compose subcommands sit behind their optional project name and file, so the word that
        // decides is the first one past them.
        (Some("compose"), _) => {
            let mut sub = index + 1;
            while matches!(argv.get(sub).map(String::as_str), Some("--project-name" | "--file")) {
                sub += 2;
            }
            matches!(argv.get(sub).map(String::as_str), Some("ls" | "ps" | "version"))
        }
        _ => false,
    }
}

// -- Remote digest -------------------------------------------------------------
//
// Asking a registry what digest a tag currently names — the question behind the image page's
// "check for updates". Two command lines can answer it, so the caller tries them as a chain and
// this module only builds them: which one a given engine can run is the capability probe's
// finding, not a guess made here.

/// The two cheap, network-free probes for whether this CLI can answer a remote-digest question.
///
/// `buildx imagetools` is the answerer that states the digest outright; `manifest inspect` is the
/// fallback that only states it for a registry that served a bare manifest. Either being present
/// is enough for the probe to pass, and neither touches the network, so the verdict is about the
/// command line and not about the registry's mood.
pub(crate) fn remote_digest_probes(runtime: ContainerRuntime) -> Result<Vec<Vec<String>>, ShellError> {
    require_docker(runtime, "the image update check on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("buildx".to_owned());
    argv.push("version".to_owned());
    let mut manifest = base(runtime, "");
    manifest.push("manifest".to_owned());
    manifest.push("inspect".to_owned());
    manifest.push("--help".to_owned());
    Ok(vec![argv, manifest])
}

/// The digest line `buildx imagetools inspect` prints for the tag's top-level object — the same
/// digest a pull records into the local image's `RepoDigests`.
pub(crate) fn imagetools_inspect(runtime: ContainerRuntime, image: &str) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "the image update check on this runtime")?;
    let image = image_reference("the image update check", image)?;
    let mut argv = base(runtime, "");
    argv.push("buildx".to_owned());
    argv.push("imagetools".to_owned());
    argv.push("inspect".to_owned());
    argv.push(image.to_owned());
    Ok(argv)
}

/// `manifest inspect --verbose` prints each manifest the tag names with its digest. For a registry
/// that served a bare manifest (not a list) that digest is the pull digest; for a list it is not,
/// and the caller says so rather than comparing a platform digest against an index digest.
pub(crate) fn manifest_inspect(runtime: ContainerRuntime, image: &str) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "the image update check on this runtime")?;
    let image = image_reference("the image update check", image)?;
    let mut argv = base(runtime, "");
    argv.push("manifest".to_owned());
    argv.push("inspect".to_owned());
    argv.push("--verbose".to_owned());
    argv.push(image.to_owned());
    Ok(argv)
}

pub(crate) fn info(runtime: ContainerRuntime, namespace: &str) -> Vec<String> {
    let mut argv = base(runtime, namespace);
    argv.push("info".to_owned());
    argv.extend(json_format_flag(runtime));
    argv
}

pub(crate) fn version(runtime: ContainerRuntime, namespace: &str) -> Vec<String> {
    let mut argv = base(runtime, namespace);
    argv.push("version".to_owned());
    argv.extend(json_format_flag(runtime));
    argv
}

// -- Networks ----------------------------------------------------------------
//
// The network surface belongs to the desktop's Docker engine, which is always Docker: the other
// runtimes' network dialects were never exercised here, and an untested command line is refused
// rather than guessed at (see `compose` below for the same decision).

fn require_docker(runtime: ContainerRuntime, what: &str) -> Result<(), ShellError> {
    if runtime == ContainerRuntime::Docker {
        return Ok(());
    }
    Err(ShellError::app_unsupported(what))
}

pub(crate) fn network_ls(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "network listing on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("network".to_owned());
    argv.push("ls".to_owned());
    argv.extend(json_format_flag(runtime));
    Ok(argv)
}

/// Inspects the named networks in one call. The names come from the engine's own `ls`, never from
/// a person, but each one still passes the identifier gate: an argv is an argv.
pub(crate) fn network_inspect(runtime: ContainerRuntime, names: &[String]) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "network inspection on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("network".to_owned());
    argv.push("inspect".to_owned());
    for name in names {
        argv.push(identifier("the network inspect request", "network name", name)?.to_owned());
    }
    Ok(argv)
}

pub(crate) fn network_create(
    runtime: ContainerRuntime,
    request: &NetworkCreateRequest,
) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "network creation on this runtime")?;
    let name = identifier("the network create request", "network name", &request.name)?;
    let mut argv = base(runtime, "");
    argv.push("network".to_owned());
    argv.push("create".to_owned());
    if !request.driver.trim().is_empty() {
        argv.push("--driver".to_owned());
        argv.push(network_driver("the network create request", &request.driver)?.to_owned());
    }
    if !request.subnet.trim().is_empty() {
        argv.push("--subnet".to_owned());
        argv.push(cidr("the network create request", "subnet", &request.subnet)?.to_owned());
    }
    if !request.gateway.trim().is_empty() {
        argv.push("--gateway".to_owned());
        argv.push(ip_address("the network create request", "gateway", &request.gateway)?.to_owned());
    }
    if !request.ip_range.trim().is_empty() {
        argv.push("--ip-range".to_owned());
        argv.push(cidr("the network create request", "IP range", &request.ip_range)?.to_owned());
    }
    if request.ipv6 {
        argv.push("--ipv6".to_owned());
    }
    argv.push(name.to_owned());
    Ok(argv)
}

pub(crate) fn network_rm(runtime: ContainerRuntime, name: &str) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "network removal on this runtime")?;
    let name = identifier("the network removal request", "network name", name)?;
    let mut argv = base(runtime, "");
    argv.push("network".to_owned());
    argv.push("rm".to_owned());
    argv.push(name.to_owned());
    Ok(argv)
}

/// A network driver's name. It rides behind `--driver`, but a driver that begins with `-` or
/// carries whitespace would still be read as two arguments or an option by the CLI.
fn network_driver<'a>(operation: &str, value: &'a str) -> Result<&'a str, ShellError> {
    let value = value.trim();
    let valid = value.chars().count() <= MAX_IDENTIFIER_CHARS
        && !value.starts_with('-')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(value)
    } else {
        Err(ShellError::container_command_failed(
            operation,
            format!("{value} is not a network driver"),
        ))
    }
}

/// One bare IP address, for the flags that take an address rather than an address range.
fn ip_address<'a>(operation: &str, kind: &str, value: &'a str) -> Result<&'a str, ShellError> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value.chars().count() <= MAX_IDENTIFIER_CHARS
        && value.chars().all(|c| c.is_ascii_hexdigit() || matches!(c, '.' | ':'))
        && !value.contains("..")
        && (value.contains('.') || value.contains(':'));
    if valid {
        Ok(value)
    } else {
        Err(ShellError::container_command_failed(
            operation,
            format!("{value} is not a {kind} address"),
        ))
    }
}

/// A CIDR the daemon will re-check: the shape check here exists so a string that could be read as
/// two arguments or an option never reaches the command line, not to second-guess the engine.
fn cidr<'a>(operation: &str, kind: &str, value: &'a str) -> Result<&'a str, ShellError> {
    let value = value.trim();
    let Some((address, prefix)) = value.rsplit_once('/') else {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{value} is not a {kind} in CIDR form"),
        ));
    };
    let prefix_ok = !prefix.is_empty()
        && prefix.len() <= 3
        && prefix.bytes().all(|byte| byte.is_ascii_digit())
        // A dotted-quad address has 32 bits to divide; a coloned one has 128.
        && prefix
            .parse::<u8>()
            .is_ok_and(|bits| bits <= if address.contains(':') { 128 } else { 32 });
    let address_ok = !address.is_empty()
        && address.chars().count() <= MAX_IDENTIFIER_CHARS
        && address.chars().all(|c| c.is_ascii_hexdigit() || matches!(c, '.' | ':'))
        && !address.contains("..")
        && (address.contains('.') || address.contains(':'));
    if prefix_ok && address_ok {
        Ok(value)
    } else {
        Err(ShellError::container_command_failed(
            operation,
            format!("{value} is not a {kind} in CIDR form"),
        ))
    }
}

// -- Disk usage, volumes, prunes ----------------------------------------------
//
// The cleanup page's readings and the volumes page's rows. Like the network surface, they belong to
// the desktop's Docker engine: the other runtimes' volume and builder dialects were never exercised
// here, and an untested command line is refused rather than guessed at.

/// The engine's own disk-usage answer, one JSON document per kind of disk object. Read-only, and
/// the reading that comes before every prune: the page shows the numbers first.
pub(crate) fn system_df(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "the disk-usage reading on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("system".to_owned());
    argv.push("df".to_owned());
    argv.extend(json_format_flag(runtime));
    Ok(argv)
}

/// Removes the stopped containers the engine counts as reclaimable. `-f` because the confirmation
/// prompt opens on a channel nobody is typing into — the confirmation happened in the interface,
/// and the acknowledged flag carried it.
pub(crate) fn container_prune(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "the container prune on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("container".to_owned());
    argv.push("prune".to_owned());
    argv.push("-f".to_owned());
    Ok(argv)
}

/// The volumes the engine holds. Read-only; the removal's guardrail is the engine's own refusal.
pub(crate) fn volume_list(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "volume listing on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("volume".to_owned());
    argv.push("ls".to_owned());
    argv.extend(json_format_flag(runtime));
    Ok(argv)
}

pub(crate) fn volume_remove(runtime: ContainerRuntime, name: &str) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "volume removal on this runtime")?;
    let name = identifier("the volume removal request", "volume name", name)?;
    let mut argv = base(runtime, "");
    argv.push("volume".to_owned());
    argv.push("rm".to_owned());
    argv.push(name.to_owned());
    Ok(argv)
}

/// Removes the volumes nothing is mounted from. No `--all`: the named volumes a person made are
/// data somebody chose to keep, and the bare prune only takes the unmounted ones — the sentence
/// the interface's confirmation carries before this command line is ever built.
pub(crate) fn volume_prune(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "the volume prune on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("volume".to_owned());
    argv.push("prune".to_owned());
    argv.push("-f".to_owned());
    Ok(argv)
}

/// Drops the build cache. The dangling cache is the reclaimable half of the build-cache reading,
/// and `-f` keeps the prompt off the channel nobody types into.
pub(crate) fn build_cache_prune(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "the build-cache prune on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("builder".to_owned());
    argv.push("prune".to_owned());
    argv.push("-f".to_owned());
    Ok(argv)
}

/// The one cheap, network-free probe for whether this CLI can answer a volume request at all —
/// the same shape the events and Compose bits are answered by. The df and prune words came to the
/// CLI in the same release, so this one probe stands for the family.
pub(crate) fn volume_probe(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    if runtime != ContainerRuntime::Docker {
        return Err(ShellError::app_unsupported("volume listing on this runtime"));
    }
    let mut argv = base(runtime, "");
    argv.push("volume".to_owned());
    argv.push("ls".to_owned());
    argv.push("--help".to_owned());
    Ok(argv)
}

// -- Compose -----------------------------------------------------------------
//
// The Compose plugin rides the same `docker` program and the same argv discipline. The project
// name, the file path and the verbs are all fixed here; a person's words reach the command line
// only through the two validators below.

/// Whether the Compose plugin answers at all. One call, one answer: this is the probe
/// `desktop_engine_open` makes, and its verdict is what trims the interface.
pub(crate) fn compose_version(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "compose projects on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("compose".to_owned());
    argv.push("version".to_owned());
    Ok(argv)
}

pub(crate) fn compose_ls(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "compose projects on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("compose".to_owned());
    argv.push("ls".to_owned());
    // Stopped projects stay visible: a project someone brought down is still a project.
    argv.push("--all".to_owned());
    argv.push("--format".to_owned());
    argv.push("json".to_owned());
    Ok(argv)
}

/// Every container that carries a Compose project label, running or not. One call feeds every
/// row of the project list its service and container counts, instead of one call per project.
pub(crate) fn compose_labelled_ps(runtime: ContainerRuntime) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "compose projects on this runtime")?;
    let mut argv = base(runtime, "");
    argv.push("ps".to_owned());
    argv.push("-a".to_owned());
    argv.push("--filter".to_owned());
    argv.push("label=com.docker.compose.project".to_owned());
    argv.extend(json_format_flag(runtime));
    Ok(argv)
}

pub(crate) fn compose_ps(runtime: ContainerRuntime, project: &str) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "compose projects on this runtime")?;
    let project = compose_project_name(project)?;
    let mut argv = base(runtime, "");
    argv.push("compose".to_owned());
    argv.push("--project-name".to_owned());
    argv.push(project.to_owned());
    argv.push("ps".to_owned());
    argv.push("--all".to_owned());
    argv.push("--format".to_owned());
    argv.push("json".to_owned());
    Ok(argv)
}

pub(crate) fn compose_up(
    runtime: ContainerRuntime,
    project: &str,
    yml_path: &str,
    detach: bool,
) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "compose projects on this runtime")?;
    let project = compose_project_name(project)?;
    let path = remote_yml_path(yml_path)?;
    let mut argv = base(runtime, "");
    argv.push("compose".to_owned());
    argv.push("--project-name".to_owned());
    argv.push(project.to_owned());
    argv.push("--file".to_owned());
    argv.push(path.to_owned());
    argv.push("up".to_owned());
    if detach {
        argv.push("--detach".to_owned());
    }
    Ok(argv)
}

pub(crate) fn compose_down(runtime: ContainerRuntime, project: &str) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "compose projects on this runtime")?;
    let project = compose_project_name(project)?;
    let mut argv = base(runtime, "");
    argv.push("compose".to_owned());
    argv.push("--project-name".to_owned());
    argv.push(project.to_owned());
    argv.push("down".to_owned());
    Ok(argv)
}

pub(crate) fn compose_restart(runtime: ContainerRuntime, project: &str) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "compose projects on this runtime")?;
    let project = compose_project_name(project)?;
    let mut argv = base(runtime, "");
    argv.push("compose".to_owned());
    argv.push("--project-name".to_owned());
    argv.push(project.to_owned());
    argv.push("restart".to_owned());
    Ok(argv)
}

pub(crate) fn compose_logs(runtime: ContainerRuntime, project: &str, tail: u32) -> Result<Vec<String>, ShellError> {
    require_docker(runtime, "compose projects on this runtime")?;
    let project = compose_project_name(project)?;
    let mut argv = base(runtime, "");
    argv.push("compose".to_owned());
    argv.push("--project-name".to_owned());
    argv.push(project.to_owned());
    argv.push("logs".to_owned());
    argv.push("--tail".to_owned());
    argv.push(tail.to_string());
    argv.push("--follow".to_owned());
    Ok(argv)
}

/// A Compose project name. The CLI lowercases and trims silently, which is exactly the silent
/// disagreement this build refuses: the name asked for is the name the engine uses, or nothing
/// runs. Compose's own grammar is `[a-z0-9][a-z0-9_-]*`.
fn compose_project_name(project: &str) -> Result<&str, ShellError> {
    let project = project.trim();
    let valid = !project.is_empty()
        && project.chars().count() <= MAX_IDENTIFIER_CHARS
        && project
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && project
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-'));
    if valid {
        Ok(project)
    } else {
        Err(ShellError::container_command_failed(
            "the compose request",
            format!("{project} is not a Compose project name"),
        ))
    }
}

/// The remote path a Compose file lives at. It must be absolute — the command runs with the
/// session's home as its working directory, and a relative path would name whatever happens to
/// be there — and it cannot begin with anything the CLI would read as an option.
fn remote_yml_path(path: &str) -> Result<&str, ShellError> {
    let path = path.trim();
    let valid = path.starts_with('/')
        && path.chars().count() <= MAX_REMOTE_PATH_CHARS
        && !path.chars().any(char::is_control)
        && !path.contains("//")
        && !path.ends_with('/');
    if valid {
        Ok(path)
    } else {
        Err(ShellError::container_command_failed(
            "the compose request",
            format!("{path} is not an absolute remote path"),
        ))
    }
}

pub(crate) fn create(
    runtime: ContainerRuntime,
    namespace: &str,
    request: &ContainerCreateRequest,
) -> Result<Vec<String>, ShellError> {
    if runtime == ContainerRuntime::Wslc && (request.interactive || request.tty) {
        return Err(ShellError::app_unsupported(
            "an interactive container on the WSLC runtime",
        ));
    }
    let image = image_reference("the create request", &request.image)?;
    let name = match request.name.trim() {
        "" => None,
        value => Some(identifier("the create request", "container name", value)?),
    };

    let mut argv = base(runtime, namespace);
    argv.push("run".to_owned());
    argv.push("-d".to_owned());
    if request.interactive {
        argv.push("-i".to_owned());
    }
    if request.tty {
        argv.push("-t".to_owned());
    }
    if let Some(name) = name {
        argv.push("--name".to_owned());
        argv.push(name.to_owned());
    }
    for port in &request.ports {
        argv.push("-p".to_owned());
        argv.push(port_mapping("the create request", port)?);
    }
    for volume in &request.volumes {
        let source = identifier("the create request", "volume source", &volume.source)?;
        let destination = identifier("the create request", "volume destination", &volume.destination)?;
        argv.push("-v".to_owned());
        if volume.read_only {
            argv.push(format!("{source}:{destination}:ro"));
        } else {
            argv.push(format!("{source}:{destination}"));
        }
    }
    for entry in &request.env {
        argv.push("-e".to_owned());
        argv.push(environment_entry("the create request", entry)?);
    }
    if runtime != ContainerRuntime::Wslc
        && let Some(policy) = restart_policy("the create request", &request.restart_policy)?
    {
        argv.push("--restart".to_owned());
        argv.push(policy.to_owned());
    }
    if request.privileged {
        argv.push("--privileged".to_owned());
    }
    // An entrypoint rides only when the request named one: the flag with no value resets to the
    // image's default, which is what leaving the field out already means. It is one word behind a
    // flag, so it passes the identifier gate like every other word the request names.
    if let Some(entrypoint) = request
        .entrypoint
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if runtime == ContainerRuntime::Wslc {
            return Err(ShellError::app_unsupported("an entrypoint on the WSLC runtime"));
        }
        let entrypoint = identifier("the create request", "entrypoint", entrypoint)?;
        argv.push("--entrypoint".to_owned());
        argv.push(entrypoint.to_owned());
    }
    for capability in &request.capabilities {
        argv.push("--cap-add".to_owned());
        argv.push(capability_name("the create request", capability)?.to_owned());
    }
    for network in &request.networks {
        argv.push("--network".to_owned());
        argv.push(identifier("the create request", "network name", network)?.to_owned());
    }
    if let Some(megabytes) = request.memory_limit_mb {
        let bytes = megabytes.checked_mul(1024 * 1024).ok_or_else(|| {
            ShellError::container_command_failed(
                "the create request",
                format!("{megabytes} MiB is not a memory limit this build will pass on"),
            )
        })?;
        argv.push("--memory".to_owned());
        argv.push(bytes.to_string());
    }
    if let Some(weight) = request.cpu_weight {
        argv.push("--cpu-shares".to_owned());
        argv.push(weight.cpu_shares().to_string());
    }
    for (key, value) in request.labels.iter().flatten() {
        argv.push("--label".to_owned());
        argv.push(label_entry("the create request", key, value)?);
    }
    argv.push(image.to_owned());
    argv.extend(split_command_line("the create request", &request.command)?);
    Ok(argv)
}

pub(crate) fn exec(
    runtime: ContainerRuntime,
    namespace: &str,
    id: &str,
    shell: &str,
) -> Result<Vec<String>, ShellError> {
    let id = identifier("the exec request", "container id", id)?;
    let shell = match shell.trim() {
        "" => "sh",
        value => identifier("the exec request", "shell", value)?,
    };
    let mut argv = base(runtime, namespace);
    argv.push("exec".to_owned());
    // `-i` keeps stdin open, `-t` allocates a terminal; the terminal this crate opens needs both.
    argv.push("-it".to_owned());
    argv.push(id.to_owned());
    argv.push(shell.to_owned());
    Ok(argv)
}

/// `cp` into or out of a container. The file channel itself is a later phase; the argv shape is
/// frozen here so the one runtime that differs stays visible beside the others.
#[allow(dead_code)]
pub(crate) fn copy(
    runtime: ContainerRuntime,
    namespace: &str,
    from: &str,
    to: &str,
) -> Result<Vec<String>, ShellError> {
    let from = identifier("the copy request", "source", from)?;
    let to = identifier("the copy request", "destination", to)?;
    let mut argv = base(runtime, namespace);
    // WSLC has no top-level `cp`; its copy lives under the `container` group.
    if runtime == ContainerRuntime::Wslc {
        argv.push("container".to_owned());
    }
    argv.push("cp".to_owned());
    argv.push(from.to_owned());
    argv.push(to.to_owned());
    Ok(argv)
}

/// Packs a container path to stdout. WSLC's `cp` writes a local file named `-` instead of
/// streaming, so the only way to read a path out of it is `tar` inside the container.
#[allow(dead_code)]
pub(crate) fn archive_export(
    runtime: ContainerRuntime,
    namespace: &str,
    id: &str,
    path: &str,
) -> Result<Vec<String>, ShellError> {
    let id = identifier("the archive request", "container id", id)?;
    let path = path.trim().trim_end_matches('/');
    if path.is_empty() || path.chars().any(char::is_control) {
        return Err(ShellError::container_command_failed(
            "the archive request",
            "container path is empty",
        ));
    }
    let (directory, name) = match path.rsplit_once('/') {
        Some((directory, name)) => (directory, name),
        None => ("/", path),
    };
    let script = format!(
        "tar cf - -C {} {}",
        posix_quote(if directory.is_empty() { "/" } else { directory }),
        posix_quote(name)
    );
    let mut argv = base(runtime, namespace);
    argv.push("exec".to_owned());
    argv.push(id.to_owned());
    argv.push("sh".to_owned());
    argv.push("-c".to_owned());
    argv.push(script);
    Ok(argv)
}

/// Quotes one word for the shell *inside* a container. Only used for scripts the container runs;
/// this machine never sees a shell.
#[allow(dead_code)]
fn posix_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

fn identifier<'a>(operation: &str, kind: &str, value: &'a str) -> Result<&'a str, ShellError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{kind} is empty"),
        ));
    }
    if value.chars().count() > MAX_IDENTIFIER_CHARS {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{kind} is longer than {MAX_IDENTIFIER_CHARS} characters"),
        ));
    }
    if value.starts_with('-') {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{kind} starts with '-', which the runtime would read as an option"),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{kind} contains a control character"),
        ));
    }
    Ok(value)
}

fn free_text<'a>(operation: &str, kind: &str, value: &'a str, limit: usize) -> Result<Option<&'a str>, ShellError> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > limit {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{kind} is longer than {limit} characters"),
        ));
    }
    if value.contains(['\n', '\r', '\0']) {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{kind} contains a line break"),
        ));
    }
    Ok(Some(value))
}

pub(crate) fn image_reference<'a>(operation: &str, value: &'a str) -> Result<&'a str, ShellError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ShellError::container_command_failed(
            operation,
            "image reference is empty",
        ));
    }
    if !valid_image_reference(value) {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{value} is not a container image reference"),
        ));
    }
    Ok(value)
}

fn platform_value<'a>(operation: &str, value: &'a str) -> Result<&'a str, ShellError> {
    let invalid = value.chars().count() > MAX_PLATFORM_CHARS
        || value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains("//")
        || value
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-')));
    if invalid {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{value} is not a platform"),
        ));
    }
    Ok(value)
}

/// Validates a namespace before it becomes a global flag. Empty means "the runtime's default".
pub(crate) fn validate_namespace(namespace: &str) -> Result<(), ShellError> {
    let namespace = namespace.trim();
    if namespace.is_empty() {
        return Ok(());
    }
    let valid = namespace.chars().count() <= MAX_IDENTIFIER_CHARS
        && !namespace.starts_with('-')
        && namespace.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && namespace
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if valid {
        Ok(())
    } else {
        Err(ShellError::container_command_failed(
            "the namespace request",
            format!("{namespace} is not a namespace name"),
        ))
    }
}

/// The registry part of an image reference, when it has one. Docker treats the first segment as a
/// host only when it looks like one (a dot, a port, or `localhost`); anything else is a repository
/// path, and pulling `library/nginx` from a registry called `library` would be wrong.
fn registry_host(reference: &str) -> Option<&str> {
    let (first, _) = reference.split_once('/')?;
    if first == "localhost" || first.contains('.') || first.contains(':') {
        Some(first)
    } else {
        None
    }
}

fn registry_address<'a>(operation: &str, value: &'a str) -> Result<&'a str, ShellError> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value.chars().count() <= MAX_IDENTIFIER_CHARS
        && !value.starts_with('-')
        && !value.contains('/')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']' | '_'));
    if valid {
        Ok(value)
    } else {
        Err(ShellError::container_command_failed(
            operation,
            format!("{value} is not a registry address"),
        ))
    }
}

fn port_mapping(operation: &str, port: &ContainerPortMapping) -> Result<String, ShellError> {
    let protocol = port.protocol.trim().to_ascii_lowercase();
    if !protocol.is_empty() && !matches!(protocol.as_str(), "tcp" | "udp" | "sctp") {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{} is not a port protocol", port.protocol),
        ));
    }
    let host_ip = port.host_ip.trim();
    if host_ip.chars().any(|c| c.is_control() || c.is_whitespace() || c == ':') || host_ip.starts_with('-') {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{host_ip} is not a host address"),
        ));
    }
    let mut mapping = format!("{}:{}", port.host_port, port.container_port);
    if !host_ip.is_empty() {
        mapping = format!("{host_ip}:{mapping}");
    }
    if !protocol.is_empty() && protocol != "tcp" {
        mapping.push('/');
        mapping.push_str(&protocol);
    }
    Ok(mapping)
}

/// One Linux capability, the way `--cap-add` takes it (`NET_ADMIN`, `SYS_TIME`, `ALL`).
fn capability_name<'a>(operation: &str, value: &'a str) -> Result<&'a str, ShellError> {
    let value = value.trim();
    let valid = !value.is_empty()
        && value.chars().count() <= MAX_IDENTIFIER_CHARS
        && !value.starts_with('-')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if valid {
        Ok(value)
    } else {
        Err(ShellError::container_command_failed(
            operation,
            format!("{value} is not a Linux capability"),
        ))
    }
}

/// One `--label KEY=VALUE` pair. The key follows Docker's label grammar; the value is free text
/// that only has to stay one argument.
fn label_entry(operation: &str, key: &str, value: &str) -> Result<String, ShellError> {
    let key = key.trim();
    let key_valid = !key.is_empty()
        && key.chars().count() <= MAX_IDENTIFIER_CHARS
        && !key.starts_with('-')
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && key.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    if !key_valid || value.chars().any(char::is_control) {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{key}={value} is not a KEY=VALUE label"),
        ));
    }
    Ok(format!("{key}={value}"))
}

fn environment_entry(operation: &str, entry: &str) -> Result<String, ShellError> {
    let entry = entry.trim();
    let Some((key, _)) = entry.split_once('=') else {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{entry} is not KEY=VALUE"),
        ));
    };
    if key.is_empty()
        || key.starts_with('-')
        || !key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.'))
    {
        return Err(ShellError::container_command_failed(
            operation,
            format!("{entry} does not start with an environment variable name"),
        ));
    }
    if entry.chars().any(char::is_control) {
        return Err(ShellError::container_command_failed(
            operation,
            "an environment entry contains a control character",
        ));
    }
    Ok(entry.to_owned())
}

fn restart_policy<'a>(operation: &str, policy: &'a str) -> Result<Option<&'a str>, ShellError> {
    let policy = policy.trim();
    if policy.is_empty() || policy.eq_ignore_ascii_case("no") {
        return Ok(None);
    }
    let lower = policy.to_ascii_lowercase();
    let named = matches!(lower.as_str(), "always" | "unless-stopped" | "on-failure");
    let with_retries = lower
        .strip_prefix("on-failure:")
        .is_some_and(|retries| !retries.is_empty() && retries.chars().all(|c| c.is_ascii_digit()));
    if named || with_retries {
        return Ok(Some(policy));
    }
    Err(ShellError::container_command_failed(
        operation,
        format!("{policy} is not a restart policy"),
    ))
}

/// Splits the create dialog's one-line command into argv. There is no shell on either side: quotes
/// group a word, they do not run anything. An unbalanced quote is refused rather than guessed at,
/// because guessing would start a container with a different command than the one on screen.
fn split_command_line(operation: &str, line: &str) -> Result<Vec<String>, ShellError> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(Vec::new());
    }
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut characters = line.chars();
    while let Some(character) = characters.next() {
        match quote {
            Some('\'') => {
                if character == '\'' {
                    quote = None;
                } else {
                    word.push(character);
                }
            }
            Some(_) => {
                if character == '"' {
                    quote = None;
                } else if character == '\\' {
                    if let Some(escaped) = characters.next() {
                        word.push(escaped);
                    }
                } else {
                    word.push(character);
                }
            }
            None => match character {
                '\'' | '"' => {
                    quote = Some(character);
                    started = true;
                }
                '\\' => {
                    if let Some(escaped) = characters.next() {
                        word.push(escaped);
                        started = true;
                    }
                }
                c if c.is_whitespace() => {
                    if started {
                        words.push(std::mem::take(&mut word));
                        started = false;
                    }
                }
                c => {
                    word.push(c);
                    started = true;
                }
            },
        }
    }
    if quote.is_some() {
        return Err(ShellError::container_command_failed(
            operation,
            "the command has an unbalanced quote",
        ));
    }
    if started {
        words.push(word);
    }
    Ok(words)
}

/// Approximates Docker's reference grammar: `[registry/]path[:tag][@digest]`. It exists to refuse
/// what the daemon would refuse, before a process is started and before the error has to be read
/// out of the CLI's prose. IPv6 registry literals are not accepted: no runtime in this crate needs
/// the bracket form, and accepting it means a second quoting story.
fn valid_image_reference(reference: &str) -> bool {
    if reference.is_empty() || reference.chars().count() > MAX_IMAGE_REFERENCE_CHARS {
        return false;
    }
    if reference.starts_with('-') || reference.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let (name, digest) = match reference.split_once('@') {
        Some((name, digest)) => (name, Some(digest)),
        None => (reference, None),
    };
    if let Some(digest) = digest
        && !valid_digest(digest)
    {
        return false;
    }

    // A colon before the last slash belongs to a registry port. Searching only the last segment
    // separates `localhost:5000/nginx` (port) from `nginx:1.27` (tag).
    let last_slash = name.rfind('/').map_or(0, |index| index + 1);
    let (name, tag) = match name[last_slash..].find(':') {
        Some(offset) => (&name[..last_slash + offset], Some(&name[last_slash + offset + 1..])),
        None => (name, None),
    };
    if let Some(tag) = tag
        && !valid_tag(tag)
    {
        return false;
    }

    let mut segments = name.split('/');
    let Some(first) = segments.next() else {
        return false;
    };
    if first.is_empty() {
        return false;
    }
    let has_registry = first == "localhost" || first.contains('.') || first.contains(':');
    let mut path: Vec<&str> = Vec::new();
    if has_registry {
        if !valid_registry(first) {
            return false;
        }
    } else {
        path.push(first);
    }
    path.extend(segments);
    !path.is_empty() && path.iter().all(|segment| valid_path_component(segment))
}

fn valid_registry(registry: &str) -> bool {
    let (host, port) = match registry.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (registry, None),
    };
    if let Some(port) = port
        && (port.is_empty() || port.len() > 5 || !port.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return false;
    }
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

fn valid_path_component(component: &str) -> bool {
    let mut after_separator = true;
    for byte in component.bytes() {
        match byte {
            b'a'..=b'z' | b'0'..=b'9' => after_separator = false,
            b'.' | b'_' | b'-' => {
                if after_separator {
                    return false;
                }
                after_separator = true;
            }
            _ => return false,
        }
    }
    !component.is_empty() && !after_separator
}

fn valid_tag(tag: &str) -> bool {
    let mut characters = tag.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !(first.is_ascii_alphanumeric() || first == '_') {
        return false;
    }
    tag.chars().count() <= 128
        && tag
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

fn valid_digest(digest: &str) -> bool {
    let Some((algorithm, hex)) = digest.split_once(':') else {
        return false;
    };
    let valid_algorithm = !algorithm.is_empty()
        && algorithm
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '+' | '.' | '_' | '-'))
        && !algorithm.starts_with(['+', '.', '_', '-'])
        && !algorithm.ends_with(['+', '.', '_', '-']);
    valid_algorithm && hex.len() >= 32 && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use sevenshell_types::{
        ContainerCpuWeight, ContainerImageTransfer, ContainerPortMapping, ContainerRegistryLogin, ContainerVolume,
        NetworkCreateRequest,
    };

    use super::*;

    fn transfer_request(image: &str) -> ContainerImageTransfer {
        ContainerImageTransfer {
            image: image.to_owned(),
            platform: String::new(),
            all_tags: false,
            insecure: false,
        }
    }

    #[test]
    fn docker_ps_asks_for_the_fields_the_list_draws_instead_of_json() {
        assert_eq!(
            list(ContainerRuntime::Docker, ""),
            vec!["docker", "ps", "-a", "--format", PS_FORMAT_DOCKER]
        );
    }

    #[test]
    fn the_verbs_this_build_only_asks_with_may_be_repeated() {
        // Every argv shape below is one the builders actually produce.
        let reads: Vec<Vec<String>> = vec![
            list(ContainerRuntime::Docker, ""),
            list(ContainerRuntime::Nerdctl, "k8s.io"),
            inspect(ContainerRuntime::Docker, "", "abc123").unwrap(),
            image_inspect(ContainerRuntime::Docker, "", "nginx:1.27").unwrap(),
            image_tags(ContainerRuntime::Docker, "", "nginx").unwrap(),
            image_history(ContainerRuntime::Docker, "", "nginx:1.27").unwrap(),
            stats(ContainerRuntime::Docker, ""),
            stats(ContainerRuntime::Wslc, ""),
            images(ContainerRuntime::Podman, ""),
            info(ContainerRuntime::Docker, ""),
            version(ContainerRuntime::Docker, ""),
            namespaces(ContainerRuntime::Nerdctl),
            network_ls(ContainerRuntime::Docker).unwrap(),
            network_inspect(ContainerRuntime::Docker, &["bridge".to_owned()]).unwrap(),
            volume_list(ContainerRuntime::Docker).unwrap(),
            system_df(ContainerRuntime::Docker).unwrap(),
            compose_version(ContainerRuntime::Docker).unwrap(),
            compose_ls(ContainerRuntime::Docker).unwrap(),
            compose_labelled_ps(ContainerRuntime::Docker).unwrap(),
            compose_ps(ContainerRuntime::Docker, "site").unwrap(),
            remote_digest_probes(ContainerRuntime::Docker).unwrap()[0].clone(),
            remote_digest_probes(ContainerRuntime::Docker).unwrap()[1].clone(),
            imagetools_inspect(ContainerRuntime::Docker, "nginx:1.27").unwrap(),
            manifest_inspect(ContainerRuntime::Docker, "nginx:1.27").unwrap(),
            events_probe(ContainerRuntime::Docker).unwrap(),
        ];
        for argv in &reads {
            assert!(
                is_idempotent_read(argv),
                "a read this build builds must be repeatable: {argv:?}"
            );
        }
    }

    #[test]
    fn everything_that_changes_the_engine_may_never_be_repeated() {
        let mutations: Vec<Vec<String>> = vec![
            action(ContainerRuntime::Docker, "", "stop", "abc123").unwrap(),
            action(ContainerRuntime::Docker, "", "rm", "abc123").unwrap(),
            rename(ContainerRuntime::Docker, "", "abc123", "web-2").unwrap(),
            create(
                ContainerRuntime::Docker,
                "",
                &ContainerCreateRequest {
                    image: "nginx:1.27".to_owned(),
                    ..ContainerCreateRequest::default()
                },
            )
            .unwrap(),
            remove_image(ContainerRuntime::Docker, "", "nginx:1.27").unwrap(),
            image_prune(ContainerRuntime::Docker, ""),
            tag(ContainerRuntime::Docker, "", "nginx:1.27", "nginx:latest").unwrap(),
            load(ContainerRuntime::Docker, ""),
            commit(
                ContainerRuntime::Docker,
                "",
                &ContainerCommitRequest {
                    container_id: "abc123".to_owned(),
                    image: "team/web:built".to_owned(),
                    author: String::new(),
                    message: String::new(),
                },
            )
            .unwrap(),
            network_create(
                ContainerRuntime::Docker,
                &NetworkCreateRequest {
                    name: "edge-net".to_owned(),
                    ..NetworkCreateRequest::default()
                },
            )
            .unwrap(),
            network_rm(ContainerRuntime::Docker, "bridge").unwrap(),
            volume_remove(ContainerRuntime::Docker, "site-data").unwrap(),
            volume_prune(ContainerRuntime::Docker).unwrap(),
            build_cache_prune(ContainerRuntime::Docker).unwrap(),
            container_prune(ContainerRuntime::Docker).unwrap(),
            compose_up(ContainerRuntime::Docker, "site", "/srv/site/compose.yml", true).unwrap(),
            compose_down(ContainerRuntime::Docker, "site").unwrap(),
            compose_restart(ContainerRuntime::Docker, "site").unwrap(),
            transfer(
                ContainerRuntime::Docker,
                "",
                ImageTransfer::Pull,
                &transfer_request("nginx:1.27"),
            )
            .unwrap(),
            events(ContainerRuntime::Docker, "").unwrap(),
            exec(ContainerRuntime::Docker, "", "abc123", "sh").unwrap(),
            copy(ContainerRuntime::Docker, "", "abc123:/etc/nginx/nginx.conf", "/tmp/nginx.conf").unwrap(),
        ];
        for argv in &mutations {
            assert!(
                !is_idempotent_read(argv),
                "a verb that changes the engine must never be repeated on a lost status: {argv:?}"
            );
        }
    }

    #[test]
    fn an_argv_this_module_never_built_reads_as_not_repeatable() {
        assert!(!is_idempotent_read(&[]));
        assert!(!is_idempotent_read(&["docker".to_owned()]));
        // A verb the builders do not produce, and a trailing-word shape they do not build either:
        // the safe default is the one that does not repeat a command.
        assert!(!is_idempotent_read(&["docker".to_owned(), "build".to_owned(), ".".to_owned()]));
        assert!(!is_idempotent_read(&["docker".to_owned(), "network".to_owned(), "rm".to_owned()]));
        // The live events stream is a stream, not a command that may be fired twice.
        assert!(!is_idempotent_read(&["docker".to_owned(), "events".to_owned(), "--format".to_owned(), "{{json .}}".to_owned()]));
    }

    #[test]
    fn nerdctl_takes_its_namespace_before_the_subcommand() {
        assert_eq!(
            list(ContainerRuntime::Nerdctl, "k8s.io"),
            vec!["nerdctl", "--namespace", "k8s.io", "ps", "-a", "--format", "{{json .}}"]
        );
    }

    #[test]
    fn wslc_asks_for_the_word_json_rather_than_a_template() {
        assert_eq!(
            list(ContainerRuntime::Wslc, ""),
            vec!["wslc", "ps", "-a", "--format", "json"]
        );
        assert_eq!(
            images(ContainerRuntime::Wslc, ""),
            vec!["wslc", "images", "--format", "json"]
        );
    }

    #[test]
    fn wslc_spells_the_log_options_differently() {
        assert_eq!(
            logs(ContainerRuntime::Wslc, "", "abc123", 50, true, true).unwrap(),
            vec!["wslc", "logs", "-n", "50", "-f", "-t", "abc123"]
        );
        assert_eq!(
            logs(ContainerRuntime::Docker, "", "abc123", 50, true, true).unwrap(),
            vec!["docker", "logs", "--tail", "50", "--timestamps", "-f", "abc123"]
        );
    }

    #[test]
    fn stats_take_one_sample_and_wslc_does_not_know_no_stream() {
        assert_eq!(
            stats(ContainerRuntime::Docker, ""),
            vec!["docker", "stats", "--no-stream", "--format", "{{json .}}"]
        );
        assert_eq!(
            stats(ContainerRuntime::Wslc, ""),
            vec!["wslc", "stats", "--format", "json"]
        );
    }

    #[test]
    fn exec_asks_for_a_terminal_and_a_shell() {
        assert_eq!(
            exec(ContainerRuntime::Docker, "", "abc123", "sh").unwrap(),
            vec!["docker", "exec", "-it", "abc123", "sh"]
        );
        assert_eq!(
            exec(ContainerRuntime::Podman, "", "abc123", "  ").unwrap(),
            vec!["podman", "exec", "-it", "abc123", "sh"]
        );
    }

    #[test]
    fn the_runtimes_disagree_about_actions_they_have() {
        assert_eq!(
            action(ContainerRuntime::Wslc, "", "start", "abc123").unwrap(),
            vec!["wslc", "start", "abc123"]
        );
        assert_eq!(
            action(ContainerRuntime::Wslc, "", "remove", "abc123").unwrap(),
            vec!["wslc", "rm", "abc123"]
        );
        for action_name in ["restart", "pause", "unpause"] {
            let error = action(ContainerRuntime::Wslc, "", action_name, "abc123").unwrap_err();
            assert_eq!(error.code(), sevenshell_error::ErrorCode::AppUnsupported);
        }
        assert_eq!(
            action(ContainerRuntime::Docker, "", "remove", "abc123").unwrap(),
            vec!["docker", "rm", "abc123"]
        );
    }

    #[test]
    fn kill_is_not_an_action_this_crate_offers() {
        let error = action(ContainerRuntime::Docker, "", "kill", "abc123").unwrap_err();
        assert_eq!(error.code(), sevenshell_error::ErrorCode::ContainerCommandFailed);
    }

    #[test]
    fn rename_is_refused_on_the_runtime_that_has_no_rename() {
        assert_eq!(
            rename(ContainerRuntime::Docker, "", "abc123", "web").unwrap(),
            vec!["docker", "rename", "abc123", "web"]
        );
        let error = rename(ContainerRuntime::Wslc, "", "abc123", "web").unwrap_err();
        assert_eq!(error.code(), sevenshell_error::ErrorCode::AppUnsupported);
    }

    #[test]
    fn an_insecure_registry_is_a_global_flag_on_nerdctl_and_a_command_flag_on_podman() {
        let mut request = transfer_request("192.168.1.10:5000/foo:1");
        request.insecure = true;
        assert_eq!(
            transfer(ContainerRuntime::Nerdctl, "default", ImageTransfer::Pull, &request).unwrap(),
            vec![
                "nerdctl",
                "--namespace",
                "default",
                "--insecure-registry",
                "192.168.1.10:5000",
                "pull",
                "192.168.1.10:5000/foo:1"
            ]
        );
        assert_eq!(
            transfer(ContainerRuntime::Podman, "", ImageTransfer::Pull, &request).unwrap(),
            vec!["podman", "pull", "--tls-verify=false", "192.168.1.10:5000/foo:1"]
        );
        // Docker and WSLC have no per-command switch; the flag must not be invented.
        assert_eq!(
            transfer(ContainerRuntime::Docker, "", ImageTransfer::Pull, &request).unwrap(),
            vec!["docker", "pull", "192.168.1.10:5000/foo:1"]
        );
    }

    #[test]
    fn every_runtime_places_platform_and_all_tags_where_it_accepts_them() {
        let mut request = transfer_request("nginx");
        request.platform = "linux/arm64".to_owned();
        request.all_tags = true;
        assert_eq!(
            transfer(ContainerRuntime::Docker, "", ImageTransfer::Pull, &request).unwrap(),
            vec!["docker", "pull", "--platform", "linux/arm64", "--all-tags", "nginx"]
        );
        assert_eq!(
            transfer(ContainerRuntime::Wslc, "", ImageTransfer::Pull, &request).unwrap(),
            vec!["wslc", "pull", "--all-tags", "nginx"]
        );
        // `--all-tags` is a pull word; a push that carried it would fail at the CLI.
        assert_eq!(
            transfer(ContainerRuntime::Docker, "", ImageTransfer::Push, &request).unwrap(),
            vec!["docker", "push", "--platform", "linux/arm64", "nginx"]
        );
    }

    #[test]
    fn login_pushes_the_password_to_standard_input_and_never_to_the_argv() {
        let login = ContainerRegistryLogin {
            registry: "registry.example.com".to_owned(),
            username: "alice".to_owned(),
            secret: sevenshell_types::SecretInput {
                value: "hunter2".to_owned(),
            },
            insecure: false,
        };
        let argv = super::login(ContainerRuntime::Docker, &login).unwrap();
        assert_eq!(
            argv,
            vec![
                "docker",
                "login",
                "--password-stdin",
                "-u",
                "alice",
                "registry.example.com"
            ]
        );
        assert!(!argv.iter().any(|argument| argument.contains("hunter2")));
    }

    #[test]
    fn an_insecure_login_puts_the_registry_flag_where_each_runtime_reads_it() {
        let mut login = ContainerRegistryLogin {
            registry: "192.168.1.10:5000".to_owned(),
            username: "alice".to_owned(),
            secret: sevenshell_types::SecretInput {
                value: "hunter2".to_owned(),
            },
            insecure: true,
        };
        assert_eq!(
            super::login(ContainerRuntime::Nerdctl, &login).unwrap(),
            vec![
                "nerdctl",
                "--insecure-registry",
                "192.168.1.10:5000",
                "login",
                "--password-stdin",
                "-u",
                "alice",
                "192.168.1.10:5000"
            ]
        );
        assert_eq!(
            super::login(ContainerRuntime::Podman, &login).unwrap(),
            vec![
                "podman",
                "login",
                "--password-stdin",
                "-u",
                "alice",
                "--tls-verify=false",
                "192.168.1.10:5000"
            ]
        );
        login.registry.clear();
        assert_eq!(
            super::login(ContainerRuntime::Docker, &login).unwrap(),
            vec!["docker", "login", "--password-stdin", "-u", "alice"]
        );
    }

    #[test]
    fn wslc_history_reads_layers_out_of_image_inspect_instead() {
        assert_eq!(
            wslc_image_inspect("", "nginx:latest").unwrap(),
            vec!["wslc", "image", "inspect", "--format", "json", "nginx:latest"]
        );
        let error = image_history(ContainerRuntime::Wslc, "", "nginx:latest").unwrap_err();
        assert_eq!(error.code(), sevenshell_error::ErrorCode::AppUnsupported);
        assert_eq!(
            image_history(ContainerRuntime::Docker, "", "abc123").unwrap(),
            vec!["docker", "history", "--no-trunc", "--format", "{{json .}}", "abc123"]
        );
    }

    #[test]
    fn wslc_copy_needs_the_container_group_and_docker_does_not() {
        assert_eq!(
            copy(ContainerRuntime::Wslc, "", "cid:/etc/nginx", "C:\\Temp\\x").unwrap(),
            vec!["wslc", "container", "cp", "cid:/etc/nginx", "C:\\Temp\\x"]
        );
        assert_eq!(
            copy(ContainerRuntime::Docker, "", "cid:/etc", "/tmp/x").unwrap(),
            vec!["docker", "cp", "cid:/etc", "/tmp/x"]
        );
    }

    #[test]
    fn wslc_reads_a_path_with_tar_because_cp_cannot_write_to_stdout() {
        assert_eq!(
            archive_export(ContainerRuntime::Wslc, "", "cid", "/etc/nginx").unwrap(),
            vec!["wslc", "exec", "cid", "sh", "-c", "tar cf - -C '/etc' 'nginx'"]
        );
    }

    #[test]
    fn create_places_every_option_before_the_image_and_the_command_after_it() {
        let request = ContainerCreateRequest {
            image: "nginx:1.27".to_owned(),
            name: "web".to_owned(),
            ports: vec![ContainerPortMapping {
                host_ip: "127.0.0.1".to_owned(),
                host_port: 8080,
                container_port: 80,
                protocol: "TCP".to_owned(),
            }],
            volumes: vec![ContainerVolume {
                source: "/data".to_owned(),
                destination: "/usr/share/nginx/html".to_owned(),
                read_only: false,
            }],
            env: vec!["MODE=fast".to_owned()],
            restart_policy: "unless-stopped".to_owned(),
            command: "nginx -g 'daemon off;'".to_owned(),
            interactive: true,
            tty: true,
            ..ContainerCreateRequest::default()
        };
        assert_eq!(
            create(ContainerRuntime::Docker, "", &request).unwrap(),
            vec![
                "docker",
                "run",
                "-d",
                "-i",
                "-t",
                "--name",
                "web",
                "-p",
                "127.0.0.1:8080:80",
                "-v",
                "/data:/usr/share/nginx/html",
                "-e",
                "MODE=fast",
                "--restart",
                "unless-stopped",
                "nginx:1.27",
                "nginx",
                "-g",
                "daemon off;"
            ]
        );
        // WSLC has no --restart and no interactive creation.
        assert_eq!(
            create(ContainerRuntime::Wslc, "", &request).unwrap_err().code(),
            sevenshell_error::ErrorCode::AppUnsupported
        );
    }

    #[test]
    fn create_refuses_a_restart_policy_it_does_not_know() {
        let request = ContainerCreateRequest {
            image: "nginx".to_owned(),
            name: String::new(),
            ports: Vec::new(),
            volumes: Vec::new(),
            env: Vec::new(),
            restart_policy: "--privileged".to_owned(),
            command: String::new(),
            interactive: false,
            tty: false,
            ..ContainerCreateRequest::default()
        };
        let error = create(ContainerRuntime::Docker, "", &request).unwrap_err();
        assert_eq!(error.code(), sevenshell_error::ErrorCode::ContainerCommandFailed);
    }

    #[test]
    fn wslc_creation_leaves_out_the_restart_policy_it_cannot_take() {
        let request = ContainerCreateRequest {
            image: "nginx".to_owned(),
            name: "web".to_owned(),
            ports: Vec::new(),
            volumes: Vec::new(),
            env: Vec::new(),
            restart_policy: "always".to_owned(),
            command: String::new(),
            interactive: false,
            tty: false,
            ..ContainerCreateRequest::default()
        };
        let argv = create(ContainerRuntime::Wslc, "", &request).unwrap();
        assert!(
            !argv.iter().any(|argument| argument == "--restart"),
            "WSLC's run does not recognise --restart: {argv:?}"
        );
        assert_eq!(argv, vec!["wslc", "run", "-d", "--name", "web", "nginx"]);
    }

    #[test]
    fn the_create_dialogs_advanced_fields_become_their_flags() {
        let request = ContainerCreateRequest {
            image: "nginx:1.27".to_owned(),
            name: "web".to_owned(),
            volumes: vec![ContainerVolume {
                source: "/srv/data".to_owned(),
                destination: "/data".to_owned(),
                read_only: true,
            }],
            privileged: true,
            capabilities: vec!["NET_ADMIN".to_owned(), "SYS_TIME".to_owned()],
            networks: vec!["mem-net".to_owned(), "bridge".to_owned()],
            memory_limit_mb: Some(512),
            cpu_weight: Some(ContainerCpuWeight::High),
            labels: Some(
                [("remark".to_owned(), "created from the wizard".to_owned())]
                    .into_iter()
                    .collect(),
            ),
            ..ContainerCreateRequest::default()
        };
        assert_eq!(
            create(ContainerRuntime::Docker, "", &request).unwrap(),
            vec![
                "docker",
                "run",
                "-d",
                "--name",
                "web",
                "-v",
                "/srv/data:/data:ro",
                "--privileged",
                "--cap-add",
                "NET_ADMIN",
                "--cap-add",
                "SYS_TIME",
                "--network",
                "mem-net",
                "--network",
                "bridge",
                "--memory",
                &(512u64 * 1024 * 1024).to_string(),
                "--cpu-shares",
                "768",
                "--label",
                "remark=created from the wizard",
                "nginx:1.27"
            ]
        );
    }

    #[test]
    fn an_ordinary_create_leaves_no_trace_of_the_advanced_fields() {
        let request = ContainerCreateRequest {
            image: "nginx".to_owned(),
            volumes: vec![ContainerVolume {
                source: "/srv/data".to_owned(),
                destination: "/data".to_owned(),
                read_only: false,
            }],
            privileged: false,
            capabilities: Vec::new(),
            networks: Vec::new(),
            memory_limit_mb: None,
            cpu_weight: None,
            labels: None,
            ..ContainerCreateRequest::default()
        };
        let argv = create(ContainerRuntime::Docker, "", &request).unwrap();
        for flag in [
            "--privileged",
            "--cap-add",
            "--network",
            "--memory",
            "--cpu-shares",
            "--label",
        ] {
            assert!(
                !argv.iter().any(|argument| argument == flag),
                "{flag} leaked into a plain create"
            );
        }
        assert_eq!(
            argv.iter().filter(|argument| *argument == "-v").count(),
            1,
            "one volume, mounted read-write"
        );
        assert_eq!(argv, vec!["docker", "run", "-d", "-v", "/srv/data:/data", "nginx"]);
    }

    #[test]
    fn the_three_cpu_weight_steps_map_the_way_the_desktop_maps_them() {
        assert_eq!(ContainerCpuWeight::High.cpu_shares(), 768);
        assert_eq!(ContainerCpuWeight::Normal.cpu_shares(), 512);
        assert_eq!(ContainerCpuWeight::Low.cpu_shares(), 256);
        let parsed: ContainerCpuWeight = serde_json::from_value(serde_json::json!("high")).unwrap();
        assert_eq!(parsed, ContainerCpuWeight::High);
        assert!(
            serde_json::from_value::<ContainerCpuWeight>(serde_json::json!("maximum")).is_err(),
            "a word the dialog never offered is refused, not guessed at"
        );
    }

    #[test]
    fn an_advanced_field_that_could_be_an_option_is_refused() {
        let bad_capability = ContainerCreateRequest {
            image: "nginx".to_owned(),
            capabilities: vec!["--privileged".to_owned()],
            ..ContainerCreateRequest::default()
        };
        assert!(create(ContainerRuntime::Docker, "", &bad_capability).is_err());
        let bad_network = ContainerCreateRequest {
            image: "nginx".to_owned(),
            networks: vec!["--network".to_owned()],
            ..ContainerCreateRequest::default()
        };
        assert!(create(ContainerRuntime::Docker, "", &bad_network).is_err());
        let bad_label = ContainerCreateRequest {
            image: "nginx".to_owned(),
            labels: Some([("-x".to_owned(), String::new())].into_iter().collect()),
            ..ContainerCreateRequest::default()
        };
        assert!(create(ContainerRuntime::Docker, "", &bad_label).is_err());
        let bad_entrypoint = ContainerCreateRequest {
            image: "nginx".to_owned(),
            entrypoint: Some("--reset".to_owned()),
            ..ContainerCreateRequest::default()
        };
        assert!(create(ContainerRuntime::Docker, "", &bad_entrypoint).is_err());
    }

    #[test]
    fn an_entrypoint_rides_only_when_the_request_named_one() {
        let with = ContainerCreateRequest {
            image: "nginx".to_owned(),
            entrypoint: Some("/docker-entrypoint.sh".to_owned()),
            command: "nginx -g 'daemon off;'".to_owned(),
            ..ContainerCreateRequest::default()
        };
        assert_eq!(
            create(ContainerRuntime::Docker, "", &with).unwrap(),
            vec![
                "docker",
                "run",
                "-d",
                "--entrypoint",
                "/docker-entrypoint.sh",
                "nginx",
                "nginx",
                "-g",
                "daemon off;"
            ]
        );
        // Absent, empty and whitespace all mean the image's own default, and none of them puts a
        // flag on the line.
        for entrypoint in [None, Some(String::new()), Some("   ".to_owned())] {
            let bare = ContainerCreateRequest {
                image: "nginx".to_owned(),
                entrypoint,
                ..ContainerCreateRequest::default()
            };
            let argv = create(ContainerRuntime::Docker, "", &bare).unwrap();
            assert!(
                !argv.iter().any(|argument| argument == "--entrypoint"),
                "an unnamed entrypoint put the flag on the line: {argv:?}"
            );
        }
        let wslc = ContainerCreateRequest {
            image: "nginx".to_owned(),
            entrypoint: Some("/docker-entrypoint.sh".to_owned()),
            ..ContainerCreateRequest::default()
        };
        assert_eq!(
            create(ContainerRuntime::Wslc, "", &wslc).unwrap_err().code(),
            sevenshell_error::ErrorCode::AppUnsupported
        );
    }

    #[test]
    fn an_option_like_container_id_is_refused_before_it_can_be_an_option() {
        for id in ["", "   ", "--help", "-x", "abc\ndef"] {
            for error in [
                inspect(ContainerRuntime::Docker, "", id).unwrap_err(),
                logs(ContainerRuntime::Docker, "", id, 10, false, false).unwrap_err(),
                action(ContainerRuntime::Docker, "", "start", id).unwrap_err(),
                rename(ContainerRuntime::Docker, "", id, "web").unwrap_err(),
                exec(ContainerRuntime::Docker, "", id, "sh").unwrap_err(),
            ] {
                assert_eq!(error.code(), sevenshell_error::ErrorCode::ContainerCommandFailed);
                assert!(error.detail().unwrap_or_default().contains("container id"), "{error:?}");
            }
        }
    }

    #[test]
    fn an_option_like_image_reference_is_refused_before_it_can_be_an_option() {
        for image in ["", "  ", "--help", "-x", "UPPER/repo", "nginx:", "nginx:ta g", "a//b"] {
            assert!(
                image_reference("the pull request", image).is_err(),
                "{image} was accepted"
            );
        }
        for image in [
            "nginx",
            "nginx:1.27",
            "library/nginx",
            "registry.example.com/team/app:sha-1234",
            "localhost:5000/app",
            "192.168.1.10:5000/app:latest",
            "app@sha256:0123456789abcdef0123456789abcdef",
        ] {
            assert_eq!(image_reference("the pull request", image).unwrap(), image);
        }
    }

    #[test]
    fn a_namespace_that_could_be_an_option_is_refused() {
        for namespace in ["-r", "--namespace", "a/b", "has space", "k8s\nio"] {
            assert!(validate_namespace(namespace).is_err(), "{namespace} was accepted");
        }
        for namespace in ["", "default", "k8s.io", "build_1"] {
            assert!(validate_namespace(namespace).is_ok(), "{namespace} was refused");
        }
    }

    #[test]
    fn a_platform_that_could_be_an_option_is_refused() {
        let mut request = transfer_request("nginx");
        request.platform = "--privileged".to_owned();
        assert!(transfer(ContainerRuntime::Docker, "", ImageTransfer::Pull, &request).is_err());
        request.platform = "linux/arm/v7".to_owned();
        assert!(transfer(ContainerRuntime::Docker, "", ImageTransfer::Pull, &request).is_ok());
    }

    #[test]
    fn the_create_dialog_command_is_split_without_a_shell() {
        let words = split_command_line("the create request", "sh -c \"echo $HOME\" 'a b'").unwrap();
        assert_eq!(words, vec!["sh", "-c", "echo $HOME", "a b"]);
        let words = split_command_line("the create request", "echo \"\"").unwrap();
        assert_eq!(words, vec!["echo", ""]);
        assert!(split_command_line("the create request", "echo 'oops").is_err());
        assert_eq!(
            split_command_line("the create request", "   ").unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn commit_and_load_are_docker_only() {
        let request = ContainerCommitRequest {
            container_id: "abc123".to_owned(),
            image: "team/web:built".to_owned(),
            author: "ops".to_owned(),
            message: "snapshot".to_owned(),
        };
        assert_eq!(
            commit(ContainerRuntime::Docker, "", &request).unwrap(),
            vec![
                "docker",
                "commit",
                "--author",
                "ops",
                "--message",
                "snapshot",
                "abc123",
                "team/web:built"
            ]
        );
        assert_eq!(
            commit(ContainerRuntime::Podman, "", &request).unwrap_err().code(),
            sevenshell_error::ErrorCode::AppUnsupported
        );
        assert_eq!(load(ContainerRuntime::Docker, ""), vec!["docker", "load"]);
    }

    #[test]
    fn namespaces_are_listed_without_a_namespace_flag() {
        assert_eq!(
            namespaces(ContainerRuntime::Nerdctl),
            vec!["nerdctl", "namespace", "ls"]
        );
    }

    #[test]
    fn a_renamed_container_cannot_carry_a_flag_for_a_name() {
        assert!(rename(ContainerRuntime::Docker, "", "abc123", "-x").is_err());
        assert!(rename(ContainerRuntime::Docker, "", "abc123", " ").is_err());
    }

    #[test]
    fn tags_are_validated_as_references() {
        assert_eq!(
            tag(ContainerRuntime::Docker, "", "abc123", "repo/name:v2").unwrap(),
            vec!["docker", "tag", "abc123", "repo/name:v2"]
        );
        assert!(tag(ContainerRuntime::Docker, "", "abc123", "--force").is_err());
    }

    #[test]
    fn a_registry_address_cannot_be_a_command_or_a_path() {
        let login = ContainerRegistryLogin {
            registry: "https://registry.example.com/v2".to_owned(),
            username: "alice".to_owned(),
            secret: sevenshell_types::SecretInput {
                value: "hunter2".to_owned(),
            },
            insecure: false,
        };
        assert!(super::login(ContainerRuntime::Docker, &login).is_err());
    }

    #[test]
    fn a_container_id_cannot_be_smuggled_in_through_the_namespace() {
        assert!(validate_namespace("--namespace").is_err());
        assert!(validate_namespace("-r").is_err());
    }

    #[test]
    fn network_listing_and_removal_are_docker_only() {
        assert_eq!(
            network_ls(ContainerRuntime::Docker).unwrap(),
            vec!["docker", "network", "ls", "--format", "{{json .}}"]
        );
        assert_eq!(
            network_rm(ContainerRuntime::Docker, "mem-net-test").unwrap(),
            vec!["docker", "network", "rm", "mem-net-test"]
        );
        for runtime in [
            ContainerRuntime::Podman,
            ContainerRuntime::Nerdctl,
            ContainerRuntime::Wslc,
        ] {
            assert_eq!(
                network_ls(runtime).unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
            assert_eq!(
                network_rm(runtime, "web").unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
        }
    }

    #[test]
    fn network_inspect_takes_several_names_in_one_call_and_refuses_an_option_shaped_one() {
        assert_eq!(
            network_inspect(ContainerRuntime::Docker, &["bridge".to_owned(), "host".to_owned()]).unwrap(),
            vec!["docker", "network", "inspect", "bridge", "host"]
        );
        assert!(network_inspect(ContainerRuntime::Docker, &["-x".to_owned()]).is_err());
    }

    #[test]
    fn the_disk_reading_and_the_prunes_are_docker_words_with_the_prompt_off() {
        assert_eq!(
            system_df(ContainerRuntime::Docker).unwrap(),
            vec!["docker", "system", "df", "--format", "{{json .}}"]
        );
        assert_eq!(
            container_prune(ContainerRuntime::Docker).unwrap(),
            vec!["docker", "container", "prune", "-f"]
        );
        assert_eq!(
            volume_prune(ContainerRuntime::Docker).unwrap(),
            vec!["docker", "volume", "prune", "-f"],
            "no --all: a bare volume prune takes the unmounted volumes only, which is the sentence the confirmation carries"
        );
        assert_eq!(
            build_cache_prune(ContainerRuntime::Docker).unwrap(),
            vec!["docker", "builder", "prune", "-f"]
        );
        for runtime in [
            ContainerRuntime::Podman,
            ContainerRuntime::Nerdctl,
            ContainerRuntime::Wslc,
        ] {
            assert_eq!(
                system_df(runtime).unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
            assert_eq!(
                container_prune(runtime).unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
            assert_eq!(
                volume_prune(runtime).unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
            assert_eq!(
                build_cache_prune(runtime).unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
        }
    }

    #[test]
    fn volume_listing_and_removal_are_docker_words_and_removal_refuses_an_option_shaped_name() {
        assert_eq!(
            volume_list(ContainerRuntime::Docker).unwrap(),
            vec!["docker", "volume", "ls", "--format", "{{json .}}"]
        );
        assert_eq!(
            volume_remove(ContainerRuntime::Docker, "site-data").unwrap(),
            vec!["docker", "volume", "rm", "site-data"]
        );
        for name in ["", "  ", "--force", "-f", "a\nb"] {
            assert!(
                volume_remove(ContainerRuntime::Docker, name).is_err(),
                "volume rm accepted {name:?}"
            );
        }
        for runtime in [
            ContainerRuntime::Podman,
            ContainerRuntime::Nerdctl,
            ContainerRuntime::Wslc,
        ] {
            assert_eq!(
                volume_list(runtime).unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
            assert_eq!(
                volume_remove(runtime, "site-data").unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
        }
        assert_eq!(
            volume_probe(ContainerRuntime::Docker).unwrap(),
            vec!["docker", "volume", "ls", "--help"],
            "the probe is network-free: a help read, not a listing"
        );
        assert!(volume_probe(ContainerRuntime::Podman).is_err());
    }

    #[test]
    fn network_create_places_every_option_before_the_name() {
        let request = NetworkCreateRequest {
            name: "mem-net-test".to_owned(),
            driver: "bridge".to_owned(),
            subnet: "172.30.0.0/24".to_owned(),
            gateway: "172.30.0.1".to_owned(),
            ip_range: "172.30.0.0/25".to_owned(),
            ipv6: true,
        };
        assert_eq!(
            network_create(ContainerRuntime::Docker, &request).unwrap(),
            vec![
                "docker",
                "network",
                "create",
                "--driver",
                "bridge",
                "--subnet",
                "172.30.0.0/24",
                "--gateway",
                "172.30.0.1",
                "--ip-range",
                "172.30.0.0/25",
                "--ipv6",
                "mem-net-test"
            ]
        );
        // Empty fields leave no flag behind, and the name is always last.
        let bare = NetworkCreateRequest {
            name: "plain".to_owned(),
            driver: String::new(),
            subnet: String::new(),
            gateway: String::new(),
            ip_range: String::new(),
            ipv6: false,
        };
        assert_eq!(
            network_create(ContainerRuntime::Docker, &bare).unwrap(),
            vec!["docker", "network", "create", "plain"]
        );
    }

    #[test]
    fn a_cidr_that_could_be_an_option_or_two_words_is_refused() {
        for subnet in [
            "--help",
            "not-a-cidr",
            "172.30.0.0",
            "/24",
            "172.30.0.0/",
            "1.2.3.4/40",
            "a b/24",
        ] {
            let request = NetworkCreateRequest {
                name: "net".to_owned(),
                driver: String::new(),
                subnet: subnet.to_owned(),
                gateway: String::new(),
                ip_range: String::new(),
                ipv6: false,
            };
            assert!(
                network_create(ContainerRuntime::Docker, &request).is_err(),
                "{subnet} was accepted"
            );
        }
        for subnet in ["172.30.0.0/24", "10.0.0.0/8", "fd00::/8", "2001:db8::/32"] {
            let request = NetworkCreateRequest {
                name: "net".to_owned(),
                driver: String::new(),
                subnet: subnet.to_owned(),
                gateway: String::new(),
                ip_range: String::new(),
                ipv6: false,
            };
            assert!(
                network_create(ContainerRuntime::Docker, &request).is_ok(),
                "{subnet} was refused"
            );
        }
    }

    #[test]
    fn a_driver_that_could_be_an_option_is_refused() {
        let request = NetworkCreateRequest {
            name: "net".to_owned(),
            driver: "--privileged".to_owned(),
            subnet: String::new(),
            gateway: String::new(),
            ip_range: String::new(),
            ipv6: false,
        };
        assert!(network_create(ContainerRuntime::Docker, &request).is_err());
    }

    #[test]
    fn a_compose_project_name_follows_the_cli_grammar() {
        assert!(compose_project_name("mem-compose-test").is_ok());
        assert!(compose_project_name("web-1").is_ok());
        for name in ["", "  ", "-x", "--help", "Web", "web/1", "a b", "has.dot"] {
            assert!(compose_project_name(name).is_err(), "{name} was accepted");
        }
    }

    #[test]
    fn compose_verbs_are_fixed_and_the_name_and_path_are_validated() {
        assert_eq!(
            compose_ls(ContainerRuntime::Docker).unwrap(),
            vec!["docker", "compose", "ls", "--all", "--format", "json"]
        );
        assert_eq!(
            compose_version(ContainerRuntime::Docker).unwrap(),
            vec!["docker", "compose", "version"]
        );
        assert_eq!(
            compose_ps(ContainerRuntime::Docker, "web").unwrap(),
            vec![
                "docker",
                "compose",
                "--project-name",
                "web",
                "ps",
                "--all",
                "--format",
                "json"
            ]
        );
        assert_eq!(
            compose_up(
                ContainerRuntime::Docker,
                "web",
                "/root/mem-compose-test/docker-compose.yml",
                true
            )
            .unwrap(),
            vec![
                "docker",
                "compose",
                "--project-name",
                "web",
                "--file",
                "/root/mem-compose-test/docker-compose.yml",
                "up",
                "--detach"
            ]
        );
        assert_eq!(
            compose_up(
                ContainerRuntime::Docker,
                "web",
                "/root/mem-compose-test/docker-compose.yml",
                false
            )
            .unwrap(),
            vec![
                "docker",
                "compose",
                "--project-name",
                "web",
                "--file",
                "/root/mem-compose-test/docker-compose.yml",
                "up"
            ]
        );
        assert_eq!(
            compose_down(ContainerRuntime::Docker, "web").unwrap(),
            vec!["docker", "compose", "--project-name", "web", "down"]
        );
        assert_eq!(
            compose_restart(ContainerRuntime::Docker, "web").unwrap(),
            vec!["docker", "compose", "--project-name", "web", "restart"]
        );
        assert_eq!(
            compose_logs(ContainerRuntime::Docker, "web", 50).unwrap(),
            vec![
                "docker",
                "compose",
                "--project-name",
                "web",
                "logs",
                "--tail",
                "50",
                "--follow"
            ]
        );
        assert_eq!(
            compose_labelled_ps(ContainerRuntime::Docker).unwrap(),
            vec![
                "docker",
                "ps",
                "-a",
                "--filter",
                "label=com.docker.compose.project",
                "--format",
                "{{json .}}"
            ]
        );
        // A project name or path that could be an option, or a relative path, never reaches a run.
        assert!(compose_ps(ContainerRuntime::Docker, "--help").is_err());
        assert!(compose_up(ContainerRuntime::Docker, "web", "relative.yml", true).is_err());
        assert!(compose_up(ContainerRuntime::Docker, "web", "/root//x.yml", true).is_err());
        assert!(compose_up(ContainerRuntime::Docker, "web", "/root/dir/", true).is_err());
        assert!(compose_down(ContainerRuntime::Docker, "web/1").is_err());
        for runtime in [
            ContainerRuntime::Podman,
            ContainerRuntime::Nerdctl,
            ContainerRuntime::Wslc,
        ] {
            assert_eq!(
                compose_ls(runtime).unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
        }
    }
    #[test]
    fn the_remote_digest_probes_are_docker_only_and_touch_no_network() {
        for runtime in [
            ContainerRuntime::Podman,
            ContainerRuntime::Nerdctl,
            ContainerRuntime::Wslc,
        ] {
            assert_eq!(
                remote_digest_probes(runtime).unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
        }
        let probes = remote_digest_probes(ContainerRuntime::Docker).unwrap();
        assert_eq!(probes.len(), 2);
        assert_eq!(probes[0], vec!["docker", "buildx", "version"]);
        assert_eq!(probes[1], vec!["docker", "manifest", "inspect", "--help"]);
    }

    #[test]
    fn the_remote_digest_queries_pass_a_validated_reference() {
        assert_eq!(
            imagetools_inspect(ContainerRuntime::Docker, "docker.gmssh.com/library/busybox:1.37").unwrap(),
            vec![
                "docker",
                "buildx",
                "imagetools",
                "inspect",
                "docker.gmssh.com/library/busybox:1.37"
            ]
        );
        assert_eq!(
            manifest_inspect(ContainerRuntime::Docker, "busybox:1.37").unwrap(),
            vec!["docker", "manifest", "inspect", "--verbose", "busybox:1.37"]
        );
        for runtime in [ContainerRuntime::Podman, ContainerRuntime::Wslc] {
            assert_eq!(
                imagetools_inspect(runtime, "busybox:1.37").unwrap_err().code(),
                sevenshell_error::ErrorCode::AppUnsupported
            );
        }
        assert!(imagetools_inspect(ContainerRuntime::Docker, "--all").is_err());
        assert!(manifest_inspect(ContainerRuntime::Docker, "").is_err());
    }
}
