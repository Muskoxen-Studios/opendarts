# open-darts

A self-hosted darts scoreboard for your home, office or pub. Play on an Autodarts
camera board or try the virtual dartboard in your browser, with nine game modes,
player profiles, statistics and achievements.

Games run locally on your computer or server. Autodarts integration uses the local
Board Manager; no Autodarts cloud game service or account is required.

## Features

- **Nine game modes** — from a quick 301 to Cricket, Golf and territory battles.
- **Live scoreboard** — scores, recent darts and an interactive board, with layouts
  for desktop screens and portrait phones.
- **Flexible matches** — legs and sets, optional round limits, and handicaps in
  supported modes so mixed abilities can play together.
- **Player order** — reuse the last game's lineup, shuffle players, or reorder
  them with mouse, touch or keyboard controls. Run a bull-off to decide the
  starting order with one dart each, rethrowing ties.
- **Help at the oche** — X01 checkout routes in the dart slots and on the board,
  plus target hints for Golf.
- **Match controls** — undo, correct a misread dart, end a turn or finish a game
  early. Physical-board turns wait for dart removal before handing over.
- **Player profiles and statistics** — career averages, best turns, 180s,
  checkouts, heatmaps and Golf handicaps.
- **Results and rematches** — final standings, game-specific performance cards,
  winning-turn replay and one-click play again.
- **Leaderboards and achievements** — seasonal standings with archived seasons,
  achievement progress and optional unlock celebrations.
- **Sounds and voice** — optional score announcements, checkout calls and sound
  effects, with volume and animation controls.
- **Board controls** — start or stop detection, reset and calibrate from the app.
- **Local network play** — open the same scoreboard on a phone or tablet beside
  the board. Profiles and match data stay in your local SQLite database.

## Game modes

Each mode includes a rules manual in the match setup screen. Follow the links
below for the full rules and options.

| Game | How it plays |
|---|---|
| [X01](packages/frontend/src/manuals/x01.md) | Count down from 170, 301, 501 or 701. Straight, double or master in/out, per-player handicaps, checkout hints and optional finishing places. |
| [Cricket](packages/frontend/src/manuals/cricket.md) | Close 15–20 and bull. Play standard or cut-throat, with live marks and marks-per-round statistics. |
| [Gotcha](packages/frontend/src/manuals/gotcha.md) | Race up to a target and knock opponents back by landing on their score. Choose exact finishes or reach-or-pass, with optional head starts. |
| [Golf](packages/frontend/src/manuals/golf.md) | Work through numbered holes using Stableford scoring. Every dart is a stroke; personal handicaps adjust as you play completed rounds. |
| [Shanghai](packages/frontend/src/manuals/shanghai.md) | Score on the round’s target number. A single, double and triple of that number in one turn wins immediately. |
| [Killer](packages/frontend/src/manuals/killer.md) | Claim a number, become a killer by hitting it, then take opponents’ lives. Last player standing wins; optional friendly fire adds risk. |
| [Even/Odd](packages/frontend/src/manuals/evenodd.md) | Even numbers add points, odd numbers subtract them. Reach the target while keeping your score moving in the right direction. |
| [Minefield](packages/frontend/src/manuals/minefield.md) | Safe hits wear down a shared board until numbers become mines. Defuse hazards or risk escalating penalties, blast zones and chain reactions. |
| [Conquest](packages/frontend/src/manuals/conquest.md) | Capture neighbouring territories and enemy capitals. Eliminate rivals or recruit them as allies, with optional split territories and fortified homes. |

## Get started

### Desktop app

Download a Windows or Linux build from the
[releases page](https://github.com/Muskoxen-Studios/opendarts/releases).

| Platform | Download |
|---|---|
| Windows | `Darts-Setup-<version>.exe` |
| Linux | `Darts-<version>.AppImage` — make it executable with `chmod +x`, then run it. |

The Windows installer is unsigned, so SmartScreen may show a warning on first run.
The app checks for updates on startup; **Darts → Check for updates** checks manually.

Add players, choose a game and start a match. Use **Settings → Dart source** to
select the virtual board or connect your Autodarts Board Manager. To open the
scoreboard on another device, use **Other devices** in the desktop menu and open
the copied address on the same network. Allow local network access through your
firewall when prompted.

### Docker

With Docker Compose installed, run from a checkout of this repository:

```bash
cp .env.example .env
docker compose up --build
```

Open **http://localhost:8099**, add players and start a match. The default source is
the clickable virtual dartboard, so no darts hardware is needed to try it.
Match data is persisted in the `darts-data` Docker volume.

### Connect an Autodarts board

Run the Autodarts Board Manager on your local network, then select **Autodarts**
in **Settings → Dart source**, enter its local URL and apply the change. You can
also set the initial source in `.env` before starting Docker:

```dotenv
SOURCE=autodarts
BOARD_URL=http://192.168.1.50:3180
```

Replace the example address with your board’s address. A source saved in Settings
overrides the environment choice when the server reconnects to the bridge.

## Your data

Player profiles need no login. Games, statistics and achievements are stored
locally; desktop updates and uninstallation leave the database in place.

| Installation | Database location |
|---|---|
| Windows desktop | `%APPDATA%\Darts\darts.db` |
| Linux desktop | `~/.config/Darts/darts.db` |
| Docker | `/data/darts.db` inside the server container, in the `darts-data` volume |
| From source | `data/darts.db` by default; override with `DB_FILE` |

Undoing or correcting a dart also updates the statistics and achievements it
affects. Resetting a leaderboard starts a new season while preserving career
records and past matches. See [Playing and player data](docs/gameplay.md) for
match controls, settings and statistics behaviour.

## Run from source

Requires **Node.js 24+**.

```bash
npm ci
```

Start these in separate terminals:

```bash
npm run dev:bridge
npm run dev:server
npm run dev:frontend
```

Open **http://localhost:5173**. For architecture, testing, packaging and release
instructions, see the [development guide](docs/development.md).
Repository guidance for coding agents lives in [AGENTS.md](AGENTS.md).

## Experimental native detection

A native image detector and 3D camera playground are available for development
and simulation. They require Python 3.10+ and are not bundled in desktop
installers or Docker services. Real-board play currently uses Autodarts;
native detection has no live camera acquisition or hardware accuracy guarantee.

See the [playground setup](docs/native-detection.md) and
[detector documentation](services/detector/README.md) for details.

## About

open-darts is an AI-generated side project built for an office dartboard and
shared for others to use. Maintenance is best effort; bug reports are welcome
in [GitHub Issues](https://github.com/Muskoxen-Studios/opendarts/issues).

This project is not affiliated with or endorsed by Autodarts.
