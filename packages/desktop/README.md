# @darts/desktop

The Electron shell. It starts the bridge and the game server as child processes
and points a window at the scoreboard. Development launches also own a local
Python detector in rendered-camera mode.

**No game logic lives here.** The docker deployment and the installed app run
the same backend, unmodified; this package starts processes, waits for them, and
shows a window. Anything that starts creeping into `main.js` about darts belongs
in `@darts/server` instead.

## Running it

Requires Node 24+ and **Python 3.10+** for automatic development detection.
The Python backend uses the standard library; no Python package install is needed.

```bash
npm run build       # first launch, and after frontend changes
npm run dev:desktop  # detector + bridge + server + desktop window
```

That runs against the working tree: your edits to the backend or the frontend
show up on the next launch, with no packaging step. The frontend is served from
`packages/frontend/dist`, so run `npm run build` after changing it — or use
`npm run dev:frontend` and its dev server for actual frontend work.

The database is `app.getPath('userData')/darts.db`, and the name is pinned to
`Darts` so a development run and an installed one share it.

## Development detector lifecycle

An unpackaged launch starts `services/detector/main.py --source rendered --port <free-port>`
on loopback, then waits up to 30 seconds for `/health` before starting the Node
backends. Health means the service is available, **not** that cameras already have
frames: renderer configuration/frame submission happens after the scoreboard loads.
The standalone detector's synthetic default is unchanged.

Python discovery, in order:

1. `DETECTOR_PYTHON` (an executable path/name, not a shell command with arguments).
2. Repository `.venv/bin/python`, or `.venv/Scripts/python.exe` on Windows.
3. `python3` on Linux/macOS, or the Windows launcher `py -3`.

The Python version probe has a five-second limit and requires 3.10+. Missing Python,
spawn errors, early exits (including exit code zero), and readiness timeouts produce
an actionable startup dialog instead of loading a broken scoreboard. Later child
failure shows a diagnostic dialog and closes the application. Quit, startup failure,
and update restart stop every owned child, with a two-second grace period before
forced termination; Windows uses `taskkill /T /F` to stop the process tree.

Overrides (set in the environment of the desktop process):

| Variable | Behaviour |
|---|---|
| `DETECTOR_URL` | Use this externally managed URL unchanged. Never start or stop a detector for it. |
| `DETECTOR_PYTHON` | Override the Python executable for the managed detector. |
| `DARTS_DETECTOR=off` | Disable automatic development detector startup. |
| `SOURCE` | An explicit value is preserved; otherwise development with a detector defaults to `native`. |

A saved source choice remains authoritative: starting the detector must not switch
an existing Autodarts/simulator/replay installation to native. With automatic
startup disabled and no external URL, the normal backend source fallback applies.
Packaged builds never auto-start Python (the detector files/runtime are not bundled).
The packaged **Darts → About native detection** menu explains external setup.

### Server/frontend integration contract

For a managed detector, desktop passes the **same actual dynamic URL**:

- `DETECTOR_URL=http://127.0.0.1:<free-port>` to both bridge and server.
- `MANAGED_DETECTOR_URL=http://127.0.0.1:<free-port>` to the server only.
- `SOURCE=native` to both only in development when `SOURCE` is not explicitly set.

For an external `DETECTOR_URL`, it passes that URL unchanged and sets the server's
`MANAGED_DETECTOR_URL` to an empty string; disabled/packaged automatic startup also
clears that flag. The flag must not be treated as active when empty.

The server must expose `DETECTOR_URL` as `settings.runtime.detectorUrl` so the frontend
can default its native URL input to the actual endpoint instead of fixed port 8091.
When the managed flag is active, the server must remap a **stored native local/previously
managed URL** to the current URL on reconnect (and when applying stale native settings).
A prior launch's ephemeral port is stale. Preserve non-native source choices and
user-configured remote native URLs. Migration/ownership detection belongs to the
server, not this shell; do not indiscriminately replace every saved native URL.

## Tests

```bash
npm -w @darts/desktop test
# equivalent, from the repository root:
node --test packages/desktop/src/runtime.test.cjs
```

No Electron GUI is started. Tests cover discovery/overrides, rendered launch arguments,
missing executables, bounded readiness, unexpected exits, forced teardown, and real
Python detector health/shutdown on an ephemeral loopback port. Python 3.10+ is required
for the real-process tests.

## How it fits together

| Piece | Job |
|---|---|
| `src/main.js` | Starts the backends, owns the window, the menu, and updates. |
| `src/runtime.js` | Finds Node/Python, plans detector startup, supervises children, picks free ports, waits for health. |
| `src/splash.html` | What is on screen for the second before the server answers. |

Ports are asked for, not assumed: a compose stack or a second copy of the app
may already hold 8080/8081, and silently attaching to someone else's scoreboard
would be a worse failure than moving.

## The bundled Node runtime

The packaged app carries its own Node 24 (`runtime/`, put there by
`scripts/package/prepare.mjs`) instead of using Electron's embedded Node.

This is a hard requirement, not caution. Electron 33 embeds Node 20, and the
backend needs two things Node 20 does not have: running TypeScript directly by
type stripping, and `node:sqlite`. In development there is no bundled runtime
and it falls back to the `node` on your PATH, which the repo already requires to
be 24+.

## Packaging

See the Packaging section of the root README. The one thing worth knowing here:
`@darts/*` must resolve through **symlinks**, because Node refuses to
type-strip TypeScript whose real path is inside `node_modules`. electron-builder
prunes those links, and `scripts/package/afterPack.cjs` puts them back.
