# Encore Bridge on Windows: launcher ↔ gateway contract

Version 1. This is the interface between the tray launcher (`Encore Bridge.exe`, source in `launcher/`) and the
gateway (`gateway/src`, run by the bundled `runtime\node.exe`). Both sides follow it; a change needs both sides and a
new `contract` number in the status (§5).

Nothing here changes Linux or Docker: every gateway behaviour below is switched on by environment variables that only
the launcher sets (`ENCORE_LAUNCHER`, `ENCORE_LAUNCHER_TOKEN`), or is Windows-only.

## 1. How the launcher starts the gateway

```
<app>\runtime\node.exe <app>\gateway\src\main.js
```

- Working folder `<app>\gateway`. `<app>` is the folder of `Encore Bridge.exe` (installed or unzipped).
- No console window (`CREATE_NO_WINDOW`). stdin, stdout and stderr are pipes to the launcher.
- node.exe runs inside the launcher's job object (kill on close, no breakaway). Everything node.exe starts (the engine,
  ffmpeg) is in the job too, so nothing outlives the launcher. The launcher also turns Windows power throttling
  (EcoQoS) off for every process in the job.
- Environment: the launcher's own environment, minus `NODE_OPTIONS` and `NODE_PATH`, plus:

| Variable | Value | Set when |
|---|---|---|
| `ENCORE_HOME` | the data root: `--data-dir`, else `ENCORE_HOME`, else `%LOCALAPPDATA%\Encore` | always |
| `ENCORE_APP_DIR` | `<app>` | always |
| `ENCORE_LAUNCHER` | `1` | always |
| `ENCORE_LAUNCHER_TOKEN` | 64 hex characters, new for every start | always |
| `FFMPEG` | `<app>\ffmpeg\ffmpeg.exe` | not set in the environment or `settings.env` |
| `ENGINE_EXE` | `<app>\engine\encore-engine.exe` (R3e's build of go-librespot) | idem |
| `ENGINE_CONFIG_TEMPLATE` | `<app>\engine\config.template.yml` | idem |
| `NODE_ENV` | `production` | not set in the environment |

- The launcher never sets `PORT`, `DATA_DIR` or any other gateway setting. It reads `PORT` (environment, then
  `settings.env`, default 8095) only to reach the loopback routes (§5) and to name the port in messages.
- Gateway side (R3g, `config.js`): with `ENCORE_HOME` set, the defaults are `settings.env` = `<ENCORE_HOME>\settings.env`,
  `DATA_DIR` = `<ENCORE_HOME>\data`, the engine config folder = `<ENCORE_HOME>\engine`. `settings.env` is loaded under
  the environment with the rules of §4.

## 2. stdin

Only when `ENCORE_LAUNCHER=1` does the gateway read stdin, as UTF-8 lines.

| Line | Meaning |
|---|---|
| `quit` | Graceful stop: stop accepting requests, stop the engine (supervisor), write state, exit with code 0, all within about 5 s. |
| end of input (EOF) | The launcher is gone: the same as `quit`. |
| anything else | Ignored (never logged with its content). |

Without `ENCORE_LAUNCHER` stdin is not touched, so Docker (tini) behaves as before.

The launcher stops the gateway like this: the `quit` line; after 8 s `POST /local/v1/shutdown` (§5); after 4 s more it
ends the job. `Restart bridge` in the tray does the same and then starts a new gateway (which re-reads `settings.env`).

## 3. Exit codes

| Code | Meaning | Launcher |
|---|---|---|
| 0 | normal stop (`quit`, EOF, SIGINT, SIGTERM, SIGBREAK) | — |
| 10 | the HTTP port is in use (`EADDRINUSE`) | no restart; explains, waits for Restart bridge |
| 11 | the HTTP port is not allowed (`EACCES`, e.g. a Windows excluded port range) | idem |
| 12 | settings error (a bad `settings.env` value, an unusable data folder) | idem |
| other | a crash | restart after 1, 2, 5, 10, 30 s; after 5 quick failures in a row it waits for Restart bridge |

Before exiting with 10, 11 or 12 the gateway logs one line that says why, at error level (for example
`E port 8095 is in use by another program`).

## 4. `settings.env`

`%LOCALAPPDATA%\Encore\settings.env` (`<ENCORE_HOME>\settings.env`). The launcher creates it from
`<app>\settings.env.template` when it is missing and never overwrites it. The gateway reads it. After that the file
is the user's, with one exception: the bridge's setup guide (`POST /admin/api/wizard/client-id`) is the only other
writer, and it changes only the file's `SPOTIFY_CLIENT_ID` lines, by the rules of §4.1. The launcher and the
gateway parse it the same way:

- UTF-8; a BOM is skipped. LF or CRLF.
- One `KEY=VALUE` per line. `KEY` and `VALUE` are trimmed. `KEY` must match `[A-Z_][A-Z0-9_]*`; other lines are
  ignored with a warning that names the line number, never its value.
- Lines whose first non-blank character is `#`, and blank lines, are ignored. There are no inline notes: a `#` after
  a value is part of the value.
- One pair of matching surrounding quotes (`"…"` or `'…'`) is removed from `VALUE`. No escapes, no `${}` expansion, no
  `export`.
- A later line for the same key wins.
- **An empty value counts as unset** (`ADMIN_PASSWORD=` means "not set here").
- Precedence: process environment > `settings.env` > built-in defaults. (Again an empty environment value counts as
  unset.)

### 4.1 Changing `SPOTIFY_CLIENT_ID`

Only the bridge's setup guide writes these lines (`gateway/src/clientid.js`, tests in `gateway/test`). The launcher
never writes `settings.env` after creating it, and the installer doesn't touch it (it asks nothing about Spotify).

A line is **active for KEY** when, after removing a leading BOM (first line only) and trimming, it doesn't start with
`#`, contains `=`, and the trimmed text before the first `=` is exactly `KEY`. Line terminators are kept per line.

- **Replace mode:** every active `SPOTIFY_CLIENT_ID` line's content becomes `SPOTIFY_CLIENT_ID=<v>` (its own
  terminator kept). With none, `SPOTIFY_CLIENT_ID=<v>` + EOL is appended, first adding an EOL if the file doesn't end
  with one. EOL = the file's first line terminator; when the file has none (an empty file), CRLF on Windows, LF
  elsewhere.
- A BOM is kept. Nothing else in the file changes, byte for byte. The new content is written to `settings.env.tmp` in
  the same folder, then renamed over `settings.env` (retried for up to 2 s while Windows refuses: an antivirus scan or
  an editor can hold the file for a moment). A missing `settings.env` is first created from the template (as the
  launcher does at start), or as an empty file when there is no template.
- `<v>` is 32 characters `0-9a-f`, lower-cased by the bridge. The value is never logged.
- A `SPOTIFY_CLIENT_ID` in the process environment wins over the file (precedence above); the setup guide then says
  the ID comes from the environment and doesn't offer to change it.

Vectors (`<v>` = `0123456789abcdef0123456789abcdef`, `⏎` = CRLF, `↵` = LF; the table's platform is "elsewhere", so a
file without a line terminator gets LF; on Windows it gets CRLF):

| # | Input | Output |
|---|---|---|
| 1 | `# note⏎SPOTIFY_CLIENT_ID=⏎PORT=8095⏎` | `# note⏎SPOTIFY_CLIENT_ID=<v>⏎PORT=8095⏎` |
| 2 | `  SPOTIFY_CLIENT_ID = "abc"  ↵` | `SPOTIFY_CLIENT_ID=<v>↵` |
| 3 | `SPOTIFY_CLIENT_ID=↵X=1↵SPOTIFY_CLIENT_ID=↵` | both lines `SPOTIFY_CLIENT_ID=<v>` |
| 4 | `#SPOTIFY_CLIENT_ID=abc` (no final EOL) | `#SPOTIFY_CLIENT_ID=abc↵SPOTIFY_CLIENT_ID=<v>↵` |
| 5 | BOM + `SPOTIFY_CLIENT_ID=↵` | BOM + `SPOTIFY_CLIENT_ID=<v>↵` |
| 6 | empty file / missing file (no template) | `SPOTIFY_CLIENT_ID=<v>` + platform EOL |
| 7 | `SPOTIFY_CLIENT_IDX=1↵spotify_client_id=2↵` | input + `SPOTIFY_CLIENT_ID=<v>↵` |
| 8 | `SPOTIFY_CLIENT_ID=abc # note↵` | `SPOTIFY_CLIENT_ID=<v>↵` |
| 9 | `SPOTIFY_CLIENT_ID=<v>⏎` | unchanged |
| 10 | `A=1⏎B=2↵` (mixed) | `A=1⏎B=2↵SPOTIFY_CLIENT_ID=<v>⏎` |

## 5. Loopback routes

Served by the gateway (R3c `http.js`; the Showcase switch itself is R2b's `showcase.js`) only when
`ENCORE_LAUNCHER_TOKEN` is set. A request is answered only if all of these hold, otherwise the answer is a plain 404
(the routes don't reveal that they exist):

- the socket's remote address is `127.0.0.1` or `::1` (proxy headers are never considered);
- the header `X-Encore-Launcher` equals the token (constant-time compare);
- there is no `Origin` header (browsers send one on cross-site requests; the launcher never does).

Nothing on these routes is ever logged with its content.

| Route | Answer |
|---|---|
| `GET /local/v1/status` | 200, the status below |
| `POST /local/v1/shutdown` | 202 `{"ok":true}`, then the same graceful stop as `quit` |
| `POST /local/v1/showcase` with `{"on":true\|false}` | 200 `{"showcase":true\|false}`: sets the bridge's persisted Showcase switch (D4), the same switch as on the admin page |
| `POST /local/v1/update` | 200 `{"ok":true}`: the launcher's update view (§9) |

### Status

Every field is always present (`null` when unknown). It never contains a person's or device's name, the Spotify
username, a playlist name, or a path.

```json
{
  "contract": 1,
  "bridge":  { "version": "1.1.0", "uptime_s": 120, "port": 8095 },
  "engine":  { "state": "running", "version": "1.1.0", "expected": "1.1.0",
               "connected": true, "signed_in": true, "restarts": 0 },
  "sign_in": null,
  "admin":   { "setup_needed": false },
  "spotify": { "connected": true },
  "phones":  { "paired": 1, "listening": 0 },
  "playing": false,
  "showcase": false,
  "phone_url": "http://192.168.1.20:8095",
  "setup":   { "complete": false },
  "update_request": null
}
```

| Field | Meaning |
|---|---|
| `contract` | 1 |
| `bridge.version` | `config.js` `version` (the shared release version, D8) |
| `engine.state` | `starting` · `running` · `restarting` (backoff) · `stopped` (gave up) · `missing` (no engine exe) · `version_mismatch` (§6) · `unmanaged` (the engine isn't the gateway's child, as on Docker) |
| `engine.version` | the version the engine reported (§6), or `null` |
| `engine.expected` | the version the gateway needs |
| `engine.connected` | the gateway reaches the engine's API |
| `engine.signed_in` | the engine has a Spotify session (`null` if unknown) |
| `engine.restarts` | engine restarts since the gateway started |
| `sign_in` | while the engine waits for a device-code sign-in: `{"url", "code", "expires_at"}`, passed through from the engine's `GET /auth/code` (`expires_at` is the engine's RFC 3339 time; Unix seconds are also accepted). Otherwise `null`. The launcher shows it only when the user asks, and only opens `url` if it is an https page on spotify.com. |
| `admin.setup_needed` | no admin password yet (first-run setup, D27) |
| `spotify.connected` | the user's own Web API account (D12) is connected |
| `phones.paired` / `phones.listening` | paired phones / phones streaming now (`encoders.listening()`) — keep-awake follows `listening` |
| `playing` | the player is playing |
| `showcase` | the bridge's Showcase switch; `null` if this gateway has no Showcase |
| `phone_url` | `http://<LAN IPv4 of the default-route adapter>:<port>` for the app's Home address (skipping virtual and VPN adapters, R3c), `null` when unknown **and always `null` while Showcase is on** |
| `update_request` | the admin page's oldest pending update request, `{"id": "<16 hex>", "action": "check" \| "install" \| "cancel"}`, or `null` (§9). Added without a new `contract` number: a launcher ignores a missing field, and an older launcher ignores the field |
| `setup.complete` | the admin page's setup guide is complete: finished by the user, or marked complete automatically for an install that is already set up (an admin password, a Client ID, a connected Spotify account and a paired phone). `false` in first-run setup mode (no admin password yet). Added without a new `contract` number: a launcher treats a missing `setup` (an older bridge) as unknown, and unknown never triggers the first-run rule (§8) |

The launcher polls the status every 2 s while the gateway runs. A 404 means "a gateway without these routes": the
tray then only says "Running", and Quit falls back to ending the job after the `quit` line.

## 6. Engine version handshake

- R3e builds `encore-engine.exe` stamped with the Encore release version (`-X main.encoreVersion=<VERSION>`, see
  `build-engine/README.md`; `<VERSION>` is the D8 shared version, the same string as `config.js` `version`).
  `encore-engine.exe --version` prints one line and exits without creating or locking anything:
  `encore-engine <VERSION> (go-librespot …, Encore patches 1-6)`. A stamped engine also logs `running encore-engine …`
  at start. (The Docker engine is unstamped: `go-librespot dev (Encore patches 1-6, unstamped)`; Docker doesn't
  manage the engine, so no check runs there.)
- The gateway's supervisor (R3g) runs `ENGINE_EXE --version` before the first start (and again after the exe file
  changed). If the second word isn't `cfg.version`, it doesn't start the engine, sets `engine.state` to
  `version_mismatch` (with `engine.version` = what the exe said and `engine.expected` = `cfg.version`), and the admin
  page says to reinstall. `ENGINE_VERSION_CHECK=0` turns the check off for development.
- The launcher is stamped with the same `<VERSION>` (`-X main.version=<VERSION>`). If `bridge.version` differs, the
  tray says the parts are from different versions (it never refuses to run).
- The bundle script takes the version from `gateway/src/config.js`, stamps the launcher with it and refuses an engine
  exe that doesn't carry it (the same string check as `build-engine/inside.sh`).

## 7. Data root

`%LOCALAPPDATA%\Encore` (D25), never roaming AppData.

| Path | Owner |
|---|---|
| `settings.env` | created by the launcher from the template at start, then the user's; read by the gateway; only its `SPOTIFY_CLIENT_ID` lines are changed, by the setup guide (§4.1) |
| `data\` | gateway (`devices.json`, `tokens.json`, `jam.json`, `wizard.json` (the setup guide's progress), caches …) |
| `engine\` | gateway supervisor: `config.yml` made from `ENGINE_CONFIG_TEMPLATE` on first run (never overwritten), plus the engine's own `state.json` and `lockfile` |
| `logs\bridge.log` (+ `.1` … `.3`, 5 MB each) | launcher: the gateway's stdout and stderr, plus the launcher's own lines (`[launcher]`). The user-profile path is replaced by `%USERPROFILE%`. The gateway writes no log file of its own on Windows. |
| `launcher.json` | launcher preferences (keep awake, open the admin page on start) |
| `update.json` | launcher: the update check's state (times, versions, asset ids and sizes, what was verified, an ETag, error codes, the download being resumed, the update whose Setup was started). No personal data, no paths (§9) |
| `updates\<ver>\` | launcher: a downloaded installer (`EncoreBridge-<ver>-setup.exe`, `.part` while downloading), the release's signed file list and its signature, and Setup's `setup.log`. Deleted once the running version is at least `<ver>`, or after 30 days. Neither Setup nor an update touches it; the uninstaller's "delete data" removes it |

## 8. Named objects and command line (launcher ↔ installer)

| Object | Purpose |
|---|---|
| mutex `Local\EncoreBridgeLauncher` | one launcher per Windows session; a second start signals the first and exits |
| mutex `Global\EncoreBridgeLauncher` | the installer's `AppMutex` (detects a launcher in any session) |
| event `Local\EncoreBridgeLauncher.quit` | set by `Encore Bridge.exe --quit`: the running launcher quits gracefully |
| event `Local\EncoreBridgeLauncher.show` | set by a second start: the running launcher brings the admin page up |

| Option | Meaning |
|---|---|
| `--autostart` | started from the Run entry: the browser opens only with **Open admin page on start** |
| `--quit` | ask the running launcher to quit and wait for it (up to 30 s); used by the installer before it replaces files |
| `--autostart-enable` / `--autostart-disable` | write or remove the per-user Run entry and exit; the installer runs the first as the signed-in user |
| `--data-dir <folder>` | use another data root (tests) |
| `--updated` | started by Setup after an update (§9): starts like `--autostart`, then once says the update is done |
| `--update-failed` | started by Setup when an update stopped the launcher but didn't finish (§9): starts like `--autostart`, then says so |

A second start while a launcher runs ignores `--updated` and `--update-failed`. Setup's own option `/ENCOREUPDATE=1`
is its update mode (§9).

Start with Windows is the per-user value `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` → `Encore Bridge` =
`"<app>\Encore Bridge.exe" --autostart`.

**Opening the admin page.** Each launcher start opens one browser tab at most, `http://127.0.0.1:<port>/admin`, as
soon as the bridge first answers (its status (§5), or a `404` from an older bridge):

- **Setup guide (first run).** Unless it was started with `--autostart`, `--updated` or `--update-failed`: when the
  admin password, the engine sign-in or the Spotify account connection is missing, `settings.env` was just created,
  or `setup.complete` is `false`. The page then shows the setup guide by itself while setup isn't complete. Until a
  page opened, this is checked again at every status: the engine sign-in is known only a few seconds later.
- **Open admin page on start** (tray checkbox, on by default, kept in `launcher.json` as `open_admin_on_start`):
  otherwise, at every start: from the Start menu, at sign-in (`--autostart`) and after an update (`--updated`,
  `--update-failed`). Off: only the first-run rule opens a page.

A second start (the `show` event) brings `/admin` up. A second start by the user always signals it; one with
`--autostart`, `--updated` or `--update-failed` only while **Open admin page on start** is on. While the first start's
page still waits for the bridge (up to a minute), the second start opens no tab of its own: that page then opens even
with the setting off. The tray's **Setup guide…** opens `http://127.0.0.1:<port>/admin?setup=1` (the guide at any
time, in review mode once complete). The installer's finish page offers **Start Encore Bridge and open the setup
guide** on a fresh install and **Start Encore Bridge now** on an upgrade; both start the launcher with no options.

## 9. Updates

Added in contract 1 without a new number (like `setup.complete`): every addition is optional on both sides.
DESIGN-UPDATES.md (internal) has the whole design; this is the interface.

**Who checks.** On Windows the launcher checks GitHub (the latest release of `mbucc9000/encore`, at most once a day
plus **Check for updates**; `UPDATE_CHECK=0` in `settings.env` or the environment turns the automatic check off), and
the bridge never contacts GitHub (`ENCORE_LAUNCHER=1`). The launcher announces a release only after its
signed file list verified against an Ed25519 key built into the launcher, and installs one only after the user chose
**Update now** and approved Windows' prompt.

**`POST /local/v1/update`** (the guard of §5: loopback, token, no `Origin`; a JSON body of at most 8 KiB). The
launcher pushes its update view after each change, after every new gateway start (once its status answers) and at
most once a second while downloading. Answer `200 {"ok":true}`; `400` when a field is outside the fixed sets or a
version doesn't match the grammar. The bridge keeps the view in memory only, never logs or stores it, and shows it on
the admin page. A bridge without the route answers `404`: the launcher stops pushing to that gateway and the tray
alone shows updates.

```json
{ "v": 1, "source": "launcher", "kind": "windows-installer",
  "current": "1.1.0", "auto": true, "auto_off": null,
  "state": "available", "checked_at": "2026-10-10T12:00:00Z", "next_check_at": "2026-10-11T12:34:00Z",
  "latest": { "version": "1.2.0", "published_at": "2026-10-10T09:00:00Z",
              "notes_url": "https://github.com/mbucc9000/encore/releases/tag/v1.2.0",
              "asset": "EncoreBridge-1.2.0-setup.exe", "size": 32443228, "sha256": "<64 hex>" },
  "error": null,
  "install": { "version": "1.2.0", "phase": "downloading", "done": 1048576, "total": 32443228, "error": null, "exit_code": null },
  "handled_request": "0123456789abcdef" }
```

| Field | Values |
|---|---|
| `kind` | `windows-installer` (this launcher's folder is the installer's `InstallLocation`), `windows-zip` (anything else) |
| `current` | the launcher's version (`X.Y.Z`, `X.Y.Z-<pre>`, or `dev`) |
| `auto` / `auto_off` | automatic checks on; else why not: `setting` (`UPDATE_CHECK=0`) or `dev_build` |
| `state` | `never` · `checking` · `up_to_date` · `available` (a verified newer release, and the last check got an answer: after a failed check Update now wouldn't install a stored release, so the view is `error`) · `error` |
| `latest` | the verified newer release, or `null`; `asset` is this kind's file and `sha256` its entry in the signed list |
| `error` | `null` or `{code, version, retry_at, http_status}`; codes `offline`, `timeout`, `rate_limited`, `http_error`, `bad_answer`, `no_release`, `incomplete_release`, `bad_signature`, `sums_entry_missing` |
| `install` | `null` or the last Update now: `phase` `downloading` · `verifying` · `waiting` (for Windows' prompt and Setup) · `cancelled` · `failed`, with `error` `download_failed`, `no_space`, `hash_mismatch`, `setup_cancelled`, `setup_failed`, `setup_start_failed` (or a check code) and Setup's `exit_code` |
| `handled_request` | optional: the id of an admin-page request the launcher acted on |

**Admin-page requests.** `GET /local/v1/status` gains `update_request` (§5): the oldest request from the admin page's
**Check now**, **Update now** or **Cancel**. The launcher acts once per id within its 2 s poll and acknowledges it
with `handled_request` in its next push; the bridge drops a request when acknowledged or after 2 minutes. The bridge
queues `install` only from a page opened on this PC (the request's socket peer is `127.0.0.1` / `::1`), so Windows'
prompt appears in front of the person who asked. The launcher then starts the update without a question of its own
(the page's button was the user's choice; Windows still asks).

**Update now** (the tray's, or an admin request): the launcher first checks the latest release again (as **Check for
updates** does: within 60 s of its last request to GitHub it reuses that answer) and pushes the view, so the tray and
the admin page name the release it then installs: the newest verified one that check found, never a release an
earlier check stored (`<ver>` below). A check that fails installs nothing and shows its error (the stored release
isn't used); one that finds nothing newer shows the up-to-date state. Then it downloads the signed file list and its
signature again and verifies them, removes the downloads of older versions from `updates\` (a failed update's
`setup.log` stays), downloads the installer to `updates\<ver>\` (resuming a `.part`), checks it against the
list through a handle that shares reading only (nobody can change, rename or delete it until Setup has started),
and starts it with the shell verb `open` (Setup is asInvoker and elevates itself, so Windows asks the user):

```
EncoreBridge-<ver>-setup.exe /SILENT /SUPPRESSMSGBOXES /NORESTART /SP- /NOCANCEL /ENCOREUPDATE=1 /LOG="<data root>\updates\<ver>\setup.log"
```

The launcher records the update as pending in `update.json` and waits. Setup's `PrepareToInstall` asks it to quit
(`--quit`, §8); the launcher logs `quit requested (update to <ver>)` and stops the bridge as usual. If Setup ends
before that (No to Windows' prompt, or an early error), the launcher clears the pending update and says so.

**Setup in update mode** (`/ENCOREUPDATE=1`) upgrades in place like any upgrade: the program folder is replaced and
the data root (`settings.env`, `data\`, `engine\`, `logs\`, `launcher.json`, `update.json`, `updates\`) is never
touched. It doesn't run `--autostart-enable` / `--autostart-disable` (the user's current Start with Windows choice
stays) and, at the end, starts the new launcher as the signed-in user with `--updated`. If it stopped the launcher but
didn't finish, it starts the installed launcher again with `--update-failed`. A launcher that starts with a pending
update older than 15 minutes and neither option says that the update didn't finish; one whose version is the pending
update's target says it is done. A launcher started with `--update-failed` (or with a pending update) that finds its
program folder incomplete (Setup had already removed old files) logs it, clears the pending update and names the
downloaded installer to run again when it still matches the signed list saved next to it (else the release page).

The installer is started by its real path (`GetFinalPathNameByHandleW` on the locked handle), with `/LOG` next to it,
and a junction found in place of `updates\` or `updates\<ver>\` is removed before the download. After an admin-page
request, the launcher asks "… Install it now?" once the installer is checked, so the user's click lets Windows bring
its permission prompt to the front.
