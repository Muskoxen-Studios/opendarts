# @darts/desktop

The Electron shell. It starts the bridge and the game server as child processes
and points a window at the scoreboard.

**No game logic lives here.** The docker deployment and the installed app run
the same backend, unmodified; this package starts processes, waits for them, and
shows a window. Anything that starts creeping into `main.js` about darts belongs
in `@darts/server` instead.

## Running it

```bash
npm run dev:desktop
```

That runs against the working tree: your edits to the backend or the frontend
show up on the next launch, with no packaging step. The frontend is served from
`packages/frontend/dist`, so run `npm run build` after changing it — or use
`npm run dev:frontend` and its dev server for actual frontend work.

The database is `app.getPath('userData')/darts.db`, and the name is pinned to
`Darts` so a development run and an installed one share it.

## How it fits together

| Piece | Job |
|---|---|
| `src/main.js` | Starts the backends, owns the window, the menu, and updates. |
| `src/runtime.js` | Finds the Node runtime, picks free ports, waits for the server. |
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
