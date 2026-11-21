# Changelog

All notable changes to 7Shell are documented in this file. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A terminal's connection can no longer be driven out of channels by its own monitor: a command
  whose channel is abandoned on timeout or refusal now sends Close, so the server frees the
  session slot instead of holding it until the whole connection dies — the outage where
  everything on one host answered "无法打开或使用 SSH 通道" came from slots held exactly this
  way (3dce0a6).
- The monitor backs off instead of hammering: a host that starts refusing channels is sampled
  again after a pause that doubles from 10s to a minute's cap, one sample at a time per
  connection, and the pause's error says why and how long (3dce0a6).
- A host whose fresh connections keep failing is not re-dialled at the rate the pages poll:
  reconnects pause with exponential backoff and jitter, capped at 30s, answered immediately
  with the failure count and the seconds left, and a success forgives the history (3dce0a6).
- A server refusing a channel open is reported as "the connection's session slots are in use"
  with its own error code (SSH-CHANNEL-REFUSED), so the interface can say what is wrong instead
  of a generic channel failure (3dce0a6).
- The desk widgets skip a tick while the previous sample is still on its way, so a sample slower
  than the 2s interval no longer stacks a command per tick on the terminal's connection
  (3dce0a6).

- The Docker manager's create action sits on the containers page's own toolbar; the empty pane
  header that carried it alone, and the second create button beside it, are gone (container).

- The desktop container row carries its own actions — shell, logs, files, start/stop and the one
  menu — instead of a lone ellipsis, and a memory column shows each container's share once the
  engine's stats answer arrives (114ad96).
- A container's logs open from that row's own button and stream in the desktop window (114ad96).
- The desktop's transfers window says what an idle panel means — nothing is moving, and where a
  transfer would come from — instead of drawing a blank frame.
- The container list's memory sampling skips itself while the engine connection is not open,
  instead of asking the backend with a connection that isn't there.

- The scrollbar is the application's own everywhere: thin, translucent and inside the panel's
  borders, on every surface that scrolls (8205762, 35bf33d, 48360a3).
- A selected row in the file tree leaves the panel's border visible instead of painting over it
  (35bf33d).
- The sidebar keeps every label whole, and a session's hover card opens under the workspace toolbar
  instead of covering it (48360a3).

- The VMware inventory's Windows-style separators are understood on every platform, so a machine's
  name falls back correctly wherever the host runs (7e020e3).

### Added

#### The charts stop being three private shapes

- The desktop's charts draw from one vocabulary now — a bar row, an area, a ring gauge, a mini bar,
  a stat tile and a widgets' trend strip, all painted from the theme's tokens and all asking the
  one threshold: 90 wears amber, 95 wears red (0a29895).
- The monitor panel's usage bars wear those tiers for the first time — 90-95 amber, past 95 red,
  calm green, and a reading that never arrived keeps the neutral ink (0a29895).
- The system panel's disk rings gain the amber step: they went straight to red at ninety, so
  ninety-four and ninety-nine wore the same colour (0a29895).
- The Docker windows' three trends are areas now, not bare lines — the samples are intervals, not
  a continuum — and the memory line wears the tier its reading earns (0a29895).

#### The desk grows a desktop's daily shape

- Windows reopen where their kind was last left: each kind's geometry is written down per session
  a hundred milliseconds after the last change settles, clamped into the desk as it is now, and
  the default opening grows to 900×600. The taskbar gains a desktop cell that empties the desk of
  visible windows and brings everything back on the next press, and the window in front is marked
  the way a launch dock marks it — a 3px bar at the cell's left edge over the wash — as the bar
  reads in three segments: getting around, what is open, the system end (d9c0558, 84b7d2b).
- The starter sheet learns to search: a 380px field that takes the focus on open, filters the
  grid after a 300ms settle, and says when nothing matches; the grid takes the reference launch
  sheet's 172px columns and the sheet arrives with the slight scale-down step (a2db09d, c6f7b6b).
- The machine's vitals sit on the desk as widgets — system (host, uptime, load), CPU busy share,
  network rate, and the fullest filesystem's fill — each card a button into the window that can
  explain its readings. Rates need two samples a known distance apart; storage wears the 90/95
  threshold colours; the pump runs only while this desktop is the tab on screen and the
  application window is visible. The set is per session, toggled in the desktop's settings
  (fcf2a5f).
- The wallpaper grows two forms beside the gradients: a solid colour with the opacity the washes
  get, and a custom picture scaled to the desk and kept on this device's storage — the session
  carries only the decision, so moving it costs the picture, not the face, and a picture without
  its bytes is the plain surface, never white chrome on a light ground (eddc0cf).

#### The desk takes the world in, and deepens its windows

- The desk takes files from outside: dropping them uploads to the session's home, the hover says
  plainly where they will land, and an upload in flight asks before the page goes away
  (6e19e8a).
- A notification centre rung by the bell: transfer completions and failures, a followed log's
  stream ending, a container task's stream ending, and the power receipt land as grouped entries
  with an unread count on the bell, opening the panel marks the batch read, and clearing needs
  the confirmation every destructive action here uses (a388faa).
- One empty state for every empty surface, drawn once: a line-drawn illustration per scene —
  no data, a load that failed, no file, no disk, no search result — at three sizes, worn by the
  trash, the container list, the image page and the notification panel (7b4c618).
- The light host's desktop: the workbench token family splits into a light default and the dark
  values it always had, while everything drawn over a wallpaper keeps the fixed white text, so
  the wallpaper line holds in both themes (75da8ca).
- A window resizes from its eight edges and corners, and dragging toward a screen edge shows
  where a snap would land — half the desk for an edge, a quarter for a corner — with the landing
  on release (bfc7e5f).
- The launcher key and Alt+Tab belong to the desk: Meta opens and closes the starter, Alt+Tab
  walks the visible windows in stacking order and does not reach into a terminal the focus is
  inside (3d2cc2f).
- The widgets' column no longer covers a door: on a narrow desk the door grid reserves the
  widgets' column, the way the reference reserves its dock's width (6893c36).

#### The desktop wears tokens, and the Docker window speaks the reference language

- The desktop chrome's colours, durations, shadows and radii moved into a `--workbench-*` /
  `--wb-*` token family in `globals.css` — glass pane, glass border, on-picture text, accent teal,
  danger, menu skin, three surface elevations, the wallpaper gradients, the reference desktop's
  three durations and two easings, three shadow tiers, the two-layer icon-label shadow, and two
  radius steps derived
  from the corner style. The window, status bar, taskbar, starter, desktop pane and the desktop's
  teal menu read the tokens instead of inline literals, with no literal colour left in any of them
  (fe64549, 6639435, 9a4664c, 249bcff).
- Two shared primitives for what the desktop draws: **WbButton** (primary/secondary/ghost at two
  sizes, with a busy state) and **WbTag** (a state on a light wash of the colour it means —
  success, danger, warning, neutral) (249bcff).
- The desktop's Docker window speaks the reference manager's language: a 220px side navigation
  with count badges that offers the overview alone while the engine is unreachable, an overview
  page with three pressable summary rows, a health lamp and CPU/memory/network lines drawn from
  stats sampled every five seconds only while somebody is looking, a container list whose states
  are tags from a nine-state table and whose actions gather under one menu with the write in
  flight named on its row, an image page with a used-status column and a pull dialog that checks
  the tag as it is typed, and a removal confirmation that says plainly that the container's data
  goes with it. The application's container tab is unchanged — the same pane draws both, and the
  tab's layout is the untouched default (03d1bf3).
- The Docker window's containers page grows the reference manager's create wizard: the header's
  one primary button opens three steps — basic settings, advanced settings in partition cards
  (ports, volumes, environment, networks, capabilities, command, resource limits), and a review —
  with every row checked as it is typed, the fields the engine's create request carries mapped
  whole, "start after creation" starting the container the engine just made, and the sections the
  request cannot carry yet drawn and marked as not applied. The application tab's own create
  dialog is untouched (39fae03, 699ea39).
- The Docker window grows a **networks** page in the reference manager's shape: name, driver,
  subnet, gateway, IPv6 and attached-container count under a 300px search, a create form that
  checks the subnet's CIDR and the gateway as they are typed, and removal behind the
  confirmation — a network the engine refuses because containers are still attached answers with
  the engine's own sentence on the page bar. The list reads when asked, never on a timer
  (9c18ef3; the engine's verbs and in-use refusal rode in with aa361c4).
- The Docker window grows a **Compose** page: projects with status tags and folded
  service-and-container counts, a creation wizard (the engine's name rule, an absolute directory,
  a YAML field that refuses broken indentation line by line, start after creation), up, down and
  restart behind the Caution gate — down says plainly the containers stop and are removed — and a
  log window that follows the engine's stream. A host whose engine cannot reach compose keeps
  only the overview, the way the reference degrades (6254720).
- The create wizard's seven advanced fields now reach the request: privileged, capabilities,
  networks chosen from the machine's own list, a memory limit, CPU weight, labels as rows, and
  per-volume read-only — the "not applied" markers leave the review (3b86ae5).
- A desktop can be handed to the system browser: the tab's chrome action — and its right-click
  menu's entry — opens this machine's desktop in the browser at a loopback address only the
  device itself can reach, one random token per application run carried in the address's
  fragment, and the application's own tab collapses to a hosting card: the connection and its
  secrets stay with the application, the interface's rendering budget moves to the browser, the
  card offers the link again (the host may have stepped down and changed its port), and one press
  takes the desktop back inside with its memory intact. A desktop opened in one of the browser's
  own windows rides the same handover — the browser tab starts straight at the deep-linked desktop
  (5e5b255, 7be2604; the embedded host itself rode in with d33bb5d).
- The browser tab carrying a hosted desktop asks before leaving while bytes are still moving, the
  same question the desktop's own drop target asks (2d94d22).
- A container's row menu gains **Monitor**: a dialog that samples the engine's per-container stats
  every five seconds — only while it is open, its window is in front and the page is visible — and
  draws CPU, memory and network as the overview's own lines do, the network as a rate measured
  between readings rather than a running total. The three chart panels became one shared shell
  (`StatSparkline`), so the overview and the monitor draw the same line at the same measure
  (da714bf).
- A container's row menu gains **Clone**: the pane inspects the container and opens the create
  wizard pre-filled from it — image, name with a `-copy` suffix, privileged, capabilities, labels,
  networks, ports, volumes, environment, command, CPU weight and memory limit — and the copy starts
  **unstarted**, the way the reference manager copies. The advanced fields the wire does not carry
  in its curated shape are read from the inspect document itself, so nothing new crosses the
  contract (17883b0).
- The container drawer's detail gains a labels section, read from the same inspect document; the
  JSON tab and its copy button were already there (17883b0).
- The log view gains an **errors only** switch: `docker logs` hands both streams down one pipe, so
  until the wire carries a stream tag the view keeps the lines that say something went wrong — and
  says so plainly when the filter leaves nothing, instead of looking like a container that has
  written nothing (96b3272).
- A desktop handed to a browser keeps its launcher: the tab's operating system eats a lone Meta
  press before the page sees the release, so Alt pressed alone opens the starter as well — the
  same "pressed alone" rule, disarmed by any other key, with Alt+S still somebody's shortcut
  (290cb37).
- The rename dialog's button names the write while it runs (`Renaming…`), and the six desktop
  Docker pages hold the reference manager's 850px floor — below it the content scrolls sideways
  instead of squeezing every column into a sliver. The application tab's layout is untouched
  (e300612).
- The Docker window's container list follows its engine by itself: the engine's own event stream
  (new `container_events_start`, probed once at open into an `eventsAvailable` bit) feeds the list,
  which reads itself once a burst settles (300ms) and realigns with a forced full read the moment
  the stream comes back — an engine without the bit keeps the manual refresh and is never polled,
  a hidden window queues nothing and reads once on return, and an ended stream reconnects on a
  geometric backoff from 1s to a 30s ceiling (204198b, 057958f).
- A container's log stream mends itself across a restart: when the follow ends because the
  container stopped, the drawer watches the list for it running again and reopens by itself,
  saying so while it waits; three reopens that ended without a single line hand the view back to
  the person, with the restart button that was always there (057958f).
- A container action that arrives late is a success with a name, not an error: a stop or remove
  whose container the engine had already settled, a pause that raced its own pause, answer
  `AlreadySatisfied` through the whole pipe, and a second click on the same write meets the first
  call — a double click is one stop, not two (204198b, 057958f).
- A container row draws the engine's healthcheck verdict beside its state (`ps` gains a `.Health`
  column; `ContainerSummary.health` stays off the wire when there is no healthcheck), and the
  overview counts a failing healthcheck inside a running container as an unhealthy engine
  (204198b, 057958f).

#### The file panel and the batch panel remember how they were used

- The file panel remembers this session's own habits: the listing comes back in the order it was
  last left in, the directories the session walked into collect into a **recent** menu beside the
  bookmarks one (newest first, capped, cleared in one press), and a row of kind chips — folders,
  documents, images, archives — narrows the listing by extension, composing with the search field.
  All three are device-side and per session; the kind filter and the search are written nowhere
  (1eb6cfb).
- The batch panel keeps the commands it has run: a run lands in a device-side history (newest
  first, capped, a repeat of the newest collapsed), a popover beside the command label offers it
  back one press at a time, and the box walks it with the arrow keys the way a shell does — up
  from the first line, down back to whatever the box said before the walk started (7ae6366).
- The transfer panel grows a **failure summary**: the failures gathered in one dialog with the
  first ten named, a "and N more" line, and a retry on each; a standing "done N / remaining M"
  tally sits in the header, and clearing the settled ones leaves anything still moving alone
  (77e98b9).

#### Linux desktop workbench

- A new connection type, **Linux desktop** (`linuxDesk`): an SSH session whose front page is a
  desktop workbench — the system card (operating system, host name, live processor, memory and
  disk readings), file quick entries with this session's recent directories, the session card
  with entries to the terminal, the file browser and the monitor pages, and power actions behind
  a confirmation and the policy matrix. It is an ordinary SSH session underneath — the same open
  order, the same host-key decisions, no remote footprint — and every surface it draws rides the
  connection it already carries (00c2c5a, 0d15ee3, 426a058, 51b2757, ae0cc7a…44373bd, a026fe2).
- The session editor's workbench section: a per-machine backdrop choice (default or one of four
  built-in wallpapers), stored on the session; the vault document moves to schema 13, and older
  documents open with the default (00c2c5a, 51b2757).
- A file browser can be opened onto the path an entry named, from the workbench's recent list
  (44373bd).

#### A desktop that behaves like one

- The workbench tab is now a desktop rather than a card page: the wallpaper covers the whole tab,
  an icon grid starts at the top left (home, terminal, monitor, system information, trash), icons
  open on a double-click or Enter and answer a right-click, a thin taskbar mirrors this session's
  open tabs and carries the power actions, and the readings moved to the monitor's system page
  (9d3178e).
- Shortcuts: a right-click on the desktop adds a path shortcut, the icons can be removed from their
  own menu, and the layout is remembered per session in the window's own storage (9d3178e).
- A trash, over the freedesktop layout the machine already keeps (`~/.local/share/Trash`) and
  entirely through the session's own file channel — nothing is installed and nothing runs. Deleting
  in the file browser now lands in the trash by default, with a direct-delete choice beside it in
  the settings (0472f31, 823defa, 98a716e, 80fc692). An entry can be put back where it came from,
  deleted for good, or the whole trash emptied behind a confirmation and the policy matrix; an
  entry whose sidecar cannot be paired is listed and deletable but not restorable, because putting
  it back would be a guess that writes somewhere.
- The process page gains its one write: "End process" on a row's menu, behind a confirmation, the
  policy matrix and an audit line (790e371, 5d355bd).
- A **system panel** over the desktop reads what the machine says about itself — services with
  their systemd state, the block-device tree, the accounts that can log in, interfaces with
  addresses and counters, routes and resolvers, and the journal's tail — and can start, restart or
  stop a service, with stopping behind a question and the policy matrix (8bdbdfd, a7310b4).
- Icon chrome on a wallpaper no longer follows the interface theme: white with a soft shadow, so
  a light theme's dark labels are never drawn on a dark picture (a7310b4).
- The system panel's disk section no longer goes blank on a machine whose disk has no partitions:
  the shell leaves an empty `children` list off the wire, and the panel now reads its absence as
  "no partitions" rather than failing to draw (73eb01c).
- The desktop's own settings, from its right-click menu: a backdrop choice that is written back to
  the session, and an icon density that stays with this window (4d1ce31).
- Desktop icons can be dragged into place — onto another icon to take its slot, or onto the
  wallpaper for the end of the grid — and the arrangement is remembered per session, with "Reset
  icon layout" in the desktop's own menu putting the default order back. The taskbar now ends in a
  clock, and clicking it opens the system panel (ab096c1).
- The desktop is now an operating-system shell, modelled on the reference product this round
  studied: a 23px status bar over the wallpaper, sticker-like icons, a full-screen application
  starter, floating windows that move, resize, minimise and maximise with the maximised one filling
  the desk, and a floating taskbar with one cell per open window and a running dot under the one in
  front. A terminal opened from the desktop lives in a window on it rather than in the tab strip,
  a file browser window opens a browser of its own and closes it with the window, and the monitor,
  system panel and trash are drawn inside windows (fdb5dd8, 00f9d80, f1f4a25). The desktop's own
  right-click menus take the reference's teal sheet with white rows; every menu opened elsewhere
  keeps the application's card (ddd1146).
- A desktop icon's **Properties** is a real card now rather than a disabled placeholder: what the
  icon is, what it opens, and — for a shortcut — the path it stands for, with "open the folder",
  "copy path" and "remove from the desktop" beside it (86e611b).
- The desktop's **Docker manager**: the machine's own Docker engine, opened over the connection the
  desktop already holds and closed with the window. Containers with their state and ports, the
  engine's stats, images, a container's logs and a container terminal — all of it the container
  workspace the application already had, now standing on the desktop as an application (c800bd1,
  6802f6d, 0ead797).
- A **transfer manager** window on the desktop: everything this session is moving, in one place,
  with each transfer's progress and stop (6802f6d).
- Motion polish on the desktop: a window settles into place when it opens and folds away before it
  is removed (its tab and engine go with it), a double-click on a title bar is the maximize
  button's other face, icons press back, and a system-wide reduced-motion request turns the
  decoration off without touching any state (0ead797).
- A **forwards manager** on the desktop: the forwards somebody opens while the desktop is up,
  listed with their mode, binding, destination and connection count, an add form that teaches the
  three shapes with scenario sentences, and a stop behind a question (f8dab9e, ef4ea1e, ee5eb35).
- A **log tracker** on the desktop: follow a file on the machine line by line (`tail -F` under the
  hood, the path quoted and gated), a stream that sticks to the bottom until somebody scrolls up,
  and a window nobody is watching stops reading - resuming may miss lines, and the copy says so
  (f8dab9e, ef4ea1e, ee5eb35).
- **Batch execution** as a desktop window: pick the hosts, write the command, read the risk verdict
  before it runs (ef4ea1e, ee5eb35).
- The system panel reads further: each service's boot state with a switch to enable or disable it
  (the states a unit file refuses are shown rather than offered), the account's crontab, the last
  twenty logins including the machine's own reboots, the firewall's state from ufw or firewalld,
  and a usage ring per mounted file system (1e7a147). A browser host older than this build answers
  the overview without the newer lists, and those sections say so instead of blanking the panel.
- A Kubernetes cluster whose address is the machine itself is reached directly rather than through
  the system proxy, which cannot reach this machine's loopback and answered instead with its own
  error (f1f4a25).
- The desktop's own settings grow the parts a desktop actually has: doors that can be checked out
  of the icon grid (home and the trash stay — they are not anybody's to hide), a taskbar that sits
  at the bottom or the middle of the desk as chosen, and screen-reader labels on every taskbar
  control (a14acc7).
- The desktop reads its doors from one table: the icon grid, the starter sheet and the taskbar now
  name, glyph and colour each door from the same list, so the Docker door is one picture everywhere
  and a door added to the table appears on every surface at once (3039854).
- The forwards manager grows the third shape: a **remote forward** (`ssh -R`) opens its port on the
  server, answered by a service of this machine (c1bcf75, 5e33e54). The add form reads its fields in
  the reverse direction and says so in its own scenario sentence, and the list draws a remote forward
  with its kind named and the arrow pointing home.
- The forwards window asks what the gate wants answered: where the policy matrix raises a question
  about an open — a remote forward always, a bind other machines could reach where a layer says so —
  the window puts it in a dialog naming what the forward exposes, and the answer rides the resend.
  A matrix set to deny still refuses, and loosening it is the only way past a denial (9d686e9,
  4c5802e).
- The forwards list keeps itself current: a forward a terminal brought up, or one stopped from
  another surface, arrives and leaves the reading on its own, with the refresh button still there
  for the asking (5e33e54).
- A **services window** on the desktop: the TCP ports the host is listening on, each with the
  process behind it, and a way in from every row — a tunnel opened to a free port here (the same
  gated `forwards.open` the forwards manager sends), or this machine's browser pointed at the local
  end of that tunnel. A host that names no listeners — or answers the older shape without the list
  at all — says so instead of drawing rows (e47cf22, ab17850).
- The file panel grows a search field: a compact box at the strip's end filters the directory it
  has already loaded by name, however it is capitalised, with the match count beside it and its
  own sentence when nothing matches; the field is session state — clearing it hands the whole
  directory back, and walking into another directory empties it (c086a1b).

### Fixed

- The starter sheet's tiles are drawn at the same plate opacity as the icon grid and the taskbar,
  which is what the "same tone everywhere" contract always said and the sheet quietly rounded off.
- A system panel or trash window left open when the connection drops no longer hangs there as an
  empty frame: it says the machine is not connected and offers the reconnect, the same sentence the
  terminal window has always answered with (f7e02da).
- Deleting one trash entry for good no longer runs straight from its icon: the question emptying
  already asks is there for this verb too, naming the entry, and only the answer carries the
  acknowledgement the policy matrix needs (928b67e).
- The system panel no longer answers a stricter matrix's question for people: start, restart,
  enable and disable travel unacknowledged, so a layer raised to Ask is met with the shell's
  refusal naming the rule rather than a silent yes (928b67e).

- The desktop's icons answer the mouse again: the layer that holds the application starter covered
  the whole desk and took every click even while the sheet inside it was closed and inert. The
  layer is now click-through, and the taskbar's side margins narrow with a narrow window instead of
  leaving a sliver of bar (5fb0c12).

From 0.4.0 each release is written in both languages under one version heading. The GitHub release
body uses the Chinese part; the update manifest keeps both and the application shows the one its
interface is speaking. Older releases stay as they were published.

从 0.4.0 起，每个版本在同一个版本标题下同时写中英文。GitHub Release 正文使用中文章节；更新清单保留两种语言，应用按界面语言显示。更早的版本保持发布时的写法。

## [0.5.0] - 2026-11-20

### English

The compatibility and file-management release. A terminal can speak UTF-8, GBK or GB18030 per
session, an OpenSSH `ProxyJump` chain is followed with every hop's key verified, and the file
manager is rebuilt around the reference's compact listing: type drawings, three columns by default,
a remembered tree and column choice, and a position switch inside each half of the panel.

#### Added

- **Session encoding:** an SSH or Telnet session chooses UTF-8, GBK or GB18030 on its own. Output is
  decoded as a stream, so a character split across two reads is completed instead of drawn as two
  replacement marks; input in another encoding is converted on the host side.
- **Backspace per session:** an SSH session can send Ctrl+H instead of DEL for Backspace.
- **ProxyJump:** a session that names an OpenSSH alias follows the file's `ProxyJump` chain —
  comma-separated hops, `user@host:port`, bracketed IPv6, `none` — recursively, outermost hop
  first. Every hop is probed and compared against the known keys before it authenticates. Saved
  jump hosts still take precedence, and a hop uses its own `IdentityFile` when its Host block names
  one.
- **OpenSSH host filter:** a field above the alias list narrows it by alias, host or account.
- **File manager:** the listing leads with a drawing chosen by extension and, where it matters, by
  the whole name; directories get a solid folder. The header splits into a path row and an action
  row so a narrow panel keeps the whole path, and a parent row above the entries replaces the
  toolbar arrow. The list opens with name, size and modified; the other three columns sit behind
  the column chooser, and the tree, folded columns and sidebar fold are remembered.
- **Positions per half:** files and commands keep separate positions on each terminal tab. The
  position switch lives in the half it moves now, and the terminal strip only toggles the halves.
- **MCP client snippets:** the access tab offers fifteen clients, Qoder first and marked
  Recommended, each with the shape it actually reads — VS Code's `servers`, Codex's TOML,
  DeepSeek Harness's YAML patch, OpenCode's `mcp.local`, Cherry Studio's settings page.

#### Fixed

- **A recorded host key answers beside an older line:** a `known_hosts` file holding several
  records for one host no longer reports a changed key when one record matches the server exactly.
  The vault comparison looks at the algorithm too, so a record of another type reads as unseen
  rather than changed. The mismatch message names the presented fingerprint and the matching
  `ssh-keygen -R` command.
- **macOS update signature:** both macOS builds produced an update archive with the same name, so a
  merged release could pair one architecture's archive with the other's signature — the reason an
  Apple Silicon update from 0.3.0 to 0.4.0 always failed verification. Each macOS archive now
  carries its architecture in its name, matching its manifest entry.
- Trusting a host key from the connection-test notice no longer closes the session editor and
  drops its draft.

#### Notes

- The vault schema is 15. A 0.4.0 build refuses a vault written by 0.5.0; back it up before
  downgrading.
- `ProxyCommand` and `Match` are still refused before a socket opens.
- The browser edition is attached to the same release for amd64 and arm64.
- The installers are not code-signed and the macOS build is not notarized. Nothing in this project
  has had a security review.

### 中文

兼容与文件管理版本。终端可以按会话选择 UTF-8、GBK 或 GB18030，OpenSSH 的 `ProxyJump` 链会被逐跳验键地跟随；文件管理器围绕参考实现的紧凑列表重做：按类型绘制的图标、默认三列、会记住的树与列，以及放在每一半面板里的位置开关。

#### 新增

- **会话编码：** SSH 与 Telnet 会话可以各自选择 UTF-8、GBK 或 GB18030。输出用流式解码，拆在两次读取之间的字符会拼完整，而不是画成两个替换符；其他编码的输入在宿主侧转码。
- **按会话的退格：** SSH 会话可以选择发送 Ctrl+H 而不是 DEL。
- **ProxyJump：** 会话指定 OpenSSH 别名后，会按文件里的 `ProxyJump` 递归跟随——逗号分隔的多跳、`user@host:port`、带方括号的 IPv6、`none`——最外层跳板先连。每一跳都先探测、与已记录的键比对，然后才认证。保存的跳板仍然优先；跳板的 Host 块写了 `IdentityFile` 就用它。
- **OpenSSH 主机筛选：** 别名列表上方的筛选框按别名、主机或账号缩小范围。
- **文件管理器：** 列表按扩展名并视情况按完整文件名取图标，目录使用实心文件夹。头部拆成路径行和动作行，窄面板也能看到完整路径；条目上方的返回上级行取代了工具栏箭头。列表默认显示名称、大小、修改时间，另外三列收在列选择器里；目录树、折叠的列和侧栏折叠都会被记住。
- **两半面板各自定位：** 每个终端标签的文件和命令保持各自的位置。位置开关移入它所移动的那一半，终端条只负责切换两半。
- **MCP 客户端片段：** 接入页提供 15 个客户端，Qoder 排第一并标记推荐；每个客户端用它真正读取的形状——VS Code 的 `servers`、Codex 的 TOML、DeepSeek Harness 的 YAML 补丁、OpenCode 的 `mcp.local`、Cherry Studio 的设置页。

#### 修复

- **已记录的主机键可以与旧记录并存：** `known_hosts` 里同一主机有多条记录时，只要其中一条与服务器完全匹配，就不再报告键已变更。保险库的比对同时看算法，另一种类型的记录按“没见过”处理而不是“已变更”。不一致的提示会给出当前指纹和对应的 `ssh-keygen -R` 命令。
- **macOS 更新签名：** 两条 macOS 构建产出同名的更新归档，合并后的 release 可能把一种架构的归档配上另一种架构的签名——0.3.0 升 0.4.0 在 Apple Silicon 上校验失败就是这个原因。现在每个 macOS 归档在文件名里带上架构，与清单条目一致。
- 从连接测试提示里信任主机键，不再关闭会话编辑器、丢失草稿。

#### 说明

- 保险库 schema 为 15。0.4.0 的版本会拒绝 0.5.0 写出的保险库；降级前请先备份。
- `ProxyCommand` 与 `Match` 仍会在建立套接字前拒绝。
- 浏览器版随同一 release 提供 amd64 与 arm64 归档。
- 安装包未做代码签名，macOS 构建未公证。本项目尚未经过安全审计。

## [0.4.0] - 2026-11-19

### English

The connection and workspace release. A working OpenSSH setup can be reused as it is, the vault can
open with the system keychain, and the workspace gains connection tests, several terminals per host,
a file panel that can move to either side or stand alone, tabs in the title bar, and one chooser for
every new tab.

#### Added

- **OpenSSH configuration:** a session may name an alias from `~/.ssh/config`; its host, account,
  port and identity are resolved on every connection. The system `known_hosts` is read-only: a
  recorded key skips the trust question, and a changed one remains a hard stop.
- **Unlock with the system store:** on Windows and macOS the key derived from the vault password can
  be sealed in the system keychain. A password unlock or change refreshes it, and a failure falls
  back to the password form.
- **Portable self-update:** a portable copy downloads, verifies and replaces itself in place, keeping
  its `data` folder.
- **Connection tests:** SSH sessions can run the complete login without opening a shell, including
  jump hosts and the final host-key decision. Telnet and raw TCP test reachability. Results arrive as
  a transient notice.
- **Several terminals per host:** the tab's duplicate entry and the session menu can open another
  independent terminal for the same host.
- **File panel placement:** each terminal can put its files at the bottom, on either side, or in a
  standalone file-manager tab. The choice is remembered for new terminals; a standalone browser is
  shared by the session and closes only when the last terminal leaves it.
- **Tabs in the title bar:** a fifth tab placement draws the tab strip inside the window's title bar,
  with a shared strip and one scrolling row.
- **New-tab chooser:** the plus opens a searchable session tree for a new tab. Groups fold locally,
  matches always stay visible, and selecting a session that is already open uses the existing
  "open in a new tab / go to it" question.
- **Appearance:** terminal text can carry its own colour per theme, and the wallpaper can show
  through the workspace panels.

#### Fixed

- A vault document written by a newer build now names the newer document instead of reporting a
  wrong password.
- Choosing a background display mode now applies the chosen mode.
- The clear button is available on every list filter.

#### Notes

- The vault schema is 14. A 0.3.0 build refuses a vault written by 0.4.0; back it up before
  downgrading.
- OpenSSH directives this build cannot honour (`ProxyJump`, `ProxyCommand`, `Match`) refuse before a
  socket opens instead of taking a different route.
- A portable copy from 0.3.0 or older must be replaced by hand once; later portable copies update
  themselves.
- The installers are not code-signed and the macOS build is not notarized. Nothing in this project
  has had a security review.

### 中文

连接与工作区版本。已有的 OpenSSH 配置可以直接复用，保险库可以通过系统钥匙串打开；工作区新增连接测试、同一设备的多个终端、可停靠到侧边或独立成页签的文件面板、标题栏标签，以及统一的新建标签页选择器。

#### 新增

- **复用 OpenSSH 配置：** 会话可以直接指定 `~/.ssh/config` 里的别名，主机、账号、端口和身份在每次连接时解析。系统 `known_hosts` 只读生效：已记录的键不再询问，变更的键仍然是硬停。
- **系统钥匙串解锁：** Windows 和 macOS 上，由保险库口令派生的密钥可以封存在系统钥匙串中；口令解锁或修改会刷新它，失败时回退到口令输入。
- **便携版自更新：** 便携副本可以下载、校验并原地替换自己，`data` 目录保持不变。
- **连接测试：** SSH 会话可以在不打开 Shell 的情况下跑完整登录，包含跳板主机和最终主机键确认；Telnet 和原始 TCP 测试可达性。结果用会消失的提示显示。
- **单设备多终端：** 标签页右键的复制入口和会话菜单都可以为同一台主机再开一个独立终端。
- **文件面板位置：** 每个终端可以把文件放在底部、左侧、右侧，或独立的文件管理器页签。位置会记为新终端的默认值；独立浏览器由会话共享，最后一个使用它的终端离开时才收起。
- **标签栏并入标题栏：** 新增第五种标签位置，把标签条画进窗口标题栏，共用同一套标签组件并且只占一行、横向滚动。
- **新建标签页选择器：** 加号打开可搜索的会话树。分组只在本次打开内折叠，搜索结果始终可见；选择已打开的会话时沿用现有的“新标签页打开 / 切到已有标签”询问。
- **外观：** 终端文字可以按主题单独设置颜色，背景壁纸可以透到工作区面板上。

#### 修复

- 更高版本写出的保险库文档现在会明确指出文档版本更新，而不是报告密码错误。
- 选择背景图片的显示方式后会真正应用所选方式。
- 所有列表筛选都提供清除按钮。

#### 说明

- 保险库 schema 为 14。0.3.0 的版本会拒绝 0.4.0 写出的保险库；降级前请先备份。
- 本版本无法支持的 OpenSSH 指令（`ProxyJump`、`ProxyCommand`、`Match`）会在建立套接字前拒绝，而不是悄悄换一条路线。
- 0.3.0 及更早的便携副本需要手动替换一次；之后的便携副本可以自更新。
- 安装包未做代码签名，macOS 构建未公证。本项目尚未经过安全审计。

## [0.3.0] - 2026-11-18

The virtual-machine release. VMware Workstation machines on this computer are part of the library
now: imported with their UUID as identity, shown with their real power state, and driven from the
same workspace and the same agent tools as everything else. The session list also learned to
interleave groups and sessions, and a directory with thousands of entries can be narrowed by name.

### Added

#### Virtual machines

- Scan the Workstation inventory and import machines as sessions, into a chosen group or a new one.
  A machine keeps its UUID when its `.vmx` is renamed or moved.
- Running, suspended and stopped are drawn apart, so a suspended machine resumes instead of
  booting. The workspace starts, resumes, stops and suspends; the power tool adds reset, pause and
  unpause. A lock left by a machine that is not running can be taken over after confirmation.
- SSH, or RDP on Windows, opens from the machine entry. The guest account and password are the
  session's own vault slot.
- Snapshots can be listed, taken, gone back to and deleted; one can be cloned, linked or full, into
  a folder chosen through a host token. `.vmtx` templates are created and deployed the same way.
- Through VMware Tools: list and check paths, copy files both ways, run programs and scripts,
  create, rename and remove, list processes, read the environment, kill a process, and install or
  upgrade Tools.
- Configuration covers CPU, memory and cores, disks to create or extend, network and serial
  adapters, SATA and NVMe controllers, shared folders, VProbes (enable, load, reset), configuration
  entries, device connection and runtime variables.
- On the host: virtual networks and port forwards, console screenshots, key sequences that need no
  guest account, and the Workstation REST service for machine reads, MAC-to-IP maps and network
  creation.
- Host locations are opaque tokens whose paths stay in the vault; imported machines are reached by
  session id. The vault schema is now 13.

#### Agent tools

- 17 built-in VMware tools cover inventory, status and power, snapshots and clones, guest reads and
  writes, console keys, configuration, host networking, templates and images, screenshots and the
  REST reads. Destructive calls stop for the same approval and are written to the same audit log as
  every other tool.

#### Files

- The open directory can be filtered by name: `Ctrl+F` or the search button turns the address bar
  into a field, matching files and folders without case; Enter hands the keyboard to the results,
  Escape puts the whole directory back, and walking into another directory drops the filter.

#### Sessions

- Groups and sessions now share one order. A dragged row lands beside the row it was released on, a
  group can sit between two sessions, pinned groups keep their band, and existing vaults are
  numbered the way they were already drawn.

### Fixed

- Workstation 26H1 installs under 64-bit `Program Files`; that folder is asked before the legacy
  one, a registry entry only counts when the binary is really there, and a missing module command
  names `VMCLI_PATH`.
- Guest operations read the password from the session's vault slot rather than the global one, which
  made an unlocked vault answer `VAULT-LOCKED`.
- Snapshot revert and delete resolve the uid the query prints (`-d` for children), a clone creates
  its destination folder, and reset is hard so it works before Tools answers.
- Console capture uses `vmcli MKS`, which works before a guest has Tools or an account.
- The Workstation REST service no longer returns `.vmx` paths in its answers.

### Notes

- The vault is at schema 13. A 0.2.0 build refuses a vault written by 0.3.0; downgrading means
  restoring a backup.
- The installers are not code-signed and the macOS build is not notarized. Windows SmartScreen and
  macOS Gatekeeper will warn; check the SHA-256 in the release notes.
- The browser edition is attached to the same release for amd64 and arm64 as `*-web.tar.gz`, built
  against the glibc 2.28 baseline. It is not part of the desktop installers.
- Signed update archives and `latest.json` are attached when the signing key is configured. The
  update channel changes only when the release is promoted.

## [0.2.0] - 2026-11-17

The browser-host release. The interface now runs in a normal browser from a loopback host, so
machines without the newer WebKit — older or locked-down Linux, including UOS and Kylin — can use
the application without a desktop shell. Terminals, files and tab handling were reworked around
how people actually use them: one shared command history, tabs that survive a dropped connection,
and a file panel whose header is a single compact strip.

### Added

#### Browser host

- A loopback-only host (`sevenshell-web`) that serves the built interface and answers the same
  command names over HTTP and a WebSocket. One transport layer, `ipc.ts`, selects the backend, so
  the interface is the same code in both hosts.
- The vault, sessions and groups, known hosts, keys, SSH terminals with host-key decisions, SFTP
  browsing and text editing, transfers, settings and application facts all work in the browser.
- The host monitor, batch execution, the command library, container and Kubernetes workspaces,
  sync, key management, SFTP upload and download, drag-and-drop upload, and container and pod file
  browsers are part of the browser surface as well.
- The assistant and external MCP servers are available in the browser: the same tool registry,
  approval prompts and audit log as the desktop, an MCP listener and stdio bridge, OAuth sign-in
  for external servers with token refresh and reconnect, resources, prompts and resource
  templates, per-session agent policy, bounded context, and the same run limits (turns, one tool
  per turn, result truncation).
- Terminal, assistant and MCP events are delivered in the desktop's envelope, so every listener
  behaves identically in both hosts.
- Downloads started in the browser appear in the transfer panel with progress, and Stop cancels
  them. ZMODEM sends and receives through the browser's own file doors.

#### Files

- The address bar is one row: breadcrumbs navigate, and the empty part of the bar or `Ctrl+L`
  turns it into a field for typing a path. Enter or Go travels; Escape or leaving the field returns
  to the breadcrumbs without navigating.
- The panel header is a compact icon strip: refresh the directory, go up, new file, new folder,
  download (only once something is selected), upload, and upload from the clipboard.
- Directory bookmarks: named remote directories kept in the settings file and reachable in one
  click from the path bar's menu.
- The panel follows a `cd` typed at the keyboard, accepted from completion, sent from the command
  bar, or sent from the command library.
- A file browser opens a connection of its own when the terminal's connection has no room for
  another channel, instead of failing when the server reaches its per-connection limit.
- Opening a binary or oversized file as text reports the editor's answer rather than a failed
  transfer.

#### Terminals and tabs

- The tab menu offers duplicating a tab, reconnecting it, reconnecting every closed terminal,
  disconnecting while keeping the tab, closing it, closing the others, closing left, closing right
  and closing all.
- Reconnecting revives the tab in place: the same id, position and title, the same scrollback, and
  the new session writes below what the old one left on screen.
- Command history is shared by every terminal window. Lines run at a prompt are recorded — except
  at password, one-time-code and confirmation prompts — deduplicated, persisted, and offered back
  from the command bar. The history list closes when a click lands anywhere else.
- The host monitor mounts only where a sample can ride an SSH connection, and comes back by itself
  when a monitorable session is on screen again. Switching it off still means switched off.
- An SSH channel failure names the channel rather than a session, which is what made a full
  connection read as an unopenable terminal.

#### Containers and clusters

- A container page keeps only the namespace picker a runtime supports, and a cluster page keeps
  its endpoint and connection state. The session's name and kind live in the tab, not in a second
  heading inside the page.

### Fixed

- Browser-host events reached listeners without the desktop envelope, which left terminals blank
  and assistant deltas undefined.
- An external MCP server reconnects after its OAuth token is refreshed.
- A disconnected terminal tab keeps its last screen and its state; it no longer shows the
  open-failure card underneath, and reconnecting no longer replaces the tab with a new one.

### Notes

- The installers are still not code-signed and the macOS build is not notarized; Windows
  SmartScreen and macOS Gatekeeper will warn. Check the SHA-256 in the release notes.
- The browser host is a separate binary (`sevenshell-web`) and is not part of the desktop
  installers; it is built and packaged on its own. The Windows, macOS and Linux desktop
  installers are unchanged in shape.
- Signed update archives and `latest.json` are attached when the release signing key is
  configured. This is the first release that can seed the update channel once it is promoted.

## [0.1.0] - 2026-11-13

The first public release: a desktop SSH and operations client for Windows, macOS and Linux.
Sessions, terminals, files, containers, clusters and host readings share one application, and
everything the application knows stays on this machine.

### Added

#### Sessions and terminals

- Saved sessions in an encrypted vault, with groups, search, import/export and one passphrase.
  Argon2id derives the key and XChaCha20-Poly1305 encrypts the contents; the passphrase is never
  stored.
- SSH with a password, private key, keyboard-interactive answers or the system key agent. Jump
  hosts, local port forwarding (`-L`) and a SOCKS5 proxy (`-D`) are part of the saved session.
- Telnet, raw TCP, serial, local shells (PowerShell, Command Prompt, Git Bash and the Unix login
  shell) and WSL on Windows.
- Tabs, search, links, keep-alive, reconnect, asciicast v2 recording, 190 colour schemes,
  typography, cursor settings and keyword highlighting seeded with 22 rules.
- Host keys are verified before authentication. An unknown key is a decision; a changed key stops
  the connection.

#### Files

- A two-pane SFTP workbench: create, rename, delete, edit text in place, upload and download.
- A transfer queue with pause, resume and retry from where a transfer stopped. Transfers outlive
  the tab that started them, and a directory can travel as one archive over SSH.
- WebDAV and FTP/FTPS folders in the same workbench, SCP fallback when a server has no SFTP
  subsystem, and ZMODEM inside the terminal with the system file dialogs.

#### Operations

- A host monitor for load, CPU, memory, swap, disks, processes, network and sockets, sampled over
  the connection that is already open. Nothing is installed on the server.
- Batch execution: one command on several hosts, a result per host and a risk verdict before it
  runs.
- A command library with `#1`–`#5` slots, history and completion.
- Sync sessions and commands to a WebDAV server, or to a snippet on GitHub, Gitee or GitLab.
- RDP on Windows through the system Remote Desktop client.

#### Containers and clusters

- Docker, Podman, nerdctl and WSLC: containers, images, logs, stats, an exec terminal, files and
  image-archive import, on this machine or through an SSH session.
- Kubernetes: kubeconfig contexts, resource lists and watches, pod logs, exec, pod files, metrics
  and YAML editing, directly or through an SSH session.

#### Assistant and MCP

- An in-app assistant for Anthropic, OpenAI-compatible endpoints and local models.
- An MCP server for external clients. The assistant and MCP clients use the same tool registry,
  risk rules, approval prompts and audit log; credentials stay in the vault.

#### Packages

- Windows x64 and ARM64: MSI, NSIS, portable ZIP and a WebView2-offline NSIS installer.
- macOS Apple silicon and Intel: DMG, plus an update archive when the release signing key is
  configured.
- Linux x64 and ARM64: AppImage, deb and rpm.
- `latest.json` covers all six platform keys when the release signing key is configured.

### Notes

- The installers are not code-signed and the macOS build is not notarized, so Windows SmartScreen
  and macOS Gatekeeper will warn. Check the SHA-256 in the release notes before running one.
- A portable Windows build keeps its vault, settings and MCP bridge in a `data` folder beside the
  executable.
