# CC Fleet

Self-hosted fleet management for [CC: Tweaked](https://tweaked.cc/) mining turtles: a browser dashboard, a Node backend, and a small Lua agent on each turtle. The backend plans the work; turtles only run single, verified actions, so a job survives disconnects, chunk unloads and restarts.

![Dashboard: three turtles sharing a quarry, with ore finds and the ore overlay](docs/screenshots/overview.png)

## Features

- **Live map** of everything the turtles have seen, per Y level, with a chunk overlay (which chunks Chunk Controllers keep loaded) and an **◆ ore overlay**, plus a **3D view** with x-ray and a Y cut-off to look into tunnels.
- **Manual control** of one or many turtles (W/S/A/D/R/F, dig, inspect, refuel), with an emergency stop, and a **right-click menu** on the map: send a turtle to a spot, start a job there, pause/resume/stop a turtle.
- **Mining jobs:** tunnel, branch mine, grid mine and quarry. Turtles return to a depot to unload and refuel, then continue where they stopped; jobs pause safely and can be resumed.
- **Finding ores:** scan every block around the work area so the map shows what's there, and follow veins of chosen ores (any mod's ores; "Any ore", Diamond, Coal, custom ids) out of the tunnel and back.
- **Ore search:** an Ores tab listing every ore seen but not mined, by type and vein, nearest first; click to jump the map there.
- **Several turtles at once:** campaigns (one job per turtle, or one tunnel/quarry split into lanes), traffic control (cell reservations, giving way early when meeting head-on, deadlock detection), a shared depot with a queue and waiting spots.
- **Simulator** with the same protocol (and a host that runs the real Lua agent) for trying things without Minecraft.

| New job: quarry with ore filters | Turtle details |
|---|---|
| <img src="docs/screenshots/job-form.png" width="320" alt="Job form"> | <img src="docs/screenshots/turtle-details.png" width="320" alt="Turtle details"> |

![Ores tab: ores seen but not mined, grouped into veins; clicking one centres the map on it](docs/screenshots/ores.png)

![3D view: a quarry dug by three turtles, its scanned walls and the ores in them](docs/screenshots/3d.png)

> **Status: Milestone 5 in progress.** In-game so far: pairing, telemetry, manual control, tunnel jobs with unloading, and chunk loading with Chunk Controllers. Also confirmed in-game: multi-turtle traffic, waiting spots, campaigns, branch mine and quarry jobs, wall scanning and ore-vein following. New and tested **outside Minecraft**: giving way early when turtles meet head-on, grid mine jobs, the Ores tab. Verify with [docs/in-game-checklist.md](docs/in-game-checklist.md). See [docs/progress.md](docs/progress.md).

## Quick start (local development)

Requires Node.js 22.13+ (24 recommended; uses the built-in `node:sqlite`).

```bash
npm install
npm run setup        # creates .env with a random dashboard password (printed once; it's in .env)
npm run build        # builds the dashboard
npm run start        # backend + dashboard on http://127.0.0.1:8787
```

In a second terminal, start some simulated turtles:

```bash
npm run sim -- --count 6
```

Open http://127.0.0.1:8787, log in with `ADMIN_PASSWORD` from `.env`, select turtles and drive them (W/S/A/D to move and turn, R/F for up and down).

A fresh simulator world includes a depot site: a chest west of the first turtle's start and a fuel chest under it. To try a job: select the first turtle → **Depots** → **New depot** → "Use … as the dock", facing **W**, fuel chest **below** → Save. Then **Jobs** → **New job** → pick Tunnel, Branch mine or Quarry → "Start in front of the turtle" → **Create & start**. Under **Finding ores** you can have it scan the walls and follow ore veins. (The sim world only has ores below the dirt, a few blocks down.)

Add `--lua` to run the **real Lua agent** (`turtle/fleet/agent.lua`, installed through the real installer) in a CC-like host instead of the TypeScript agent:

```bash
npm run sim -- --lua --count 3 --data ./sim-data-lua
```

Simulator options: `--chunky` (equip a Chunk Controller), `--count N`, `--speed 2` (faster ops), `--reset` (fresh world and turtles), `--no-calibrate` (start with unknown pose), `--no-gps`. Simulated turtles are registered in the world `sim`, so their map never mixes with real data. They are marked **SIM** everywhere.

### Hot-reload development

```bash
npm run dev          # backend (tsx watch) on :8787 + Vite on http://127.0.0.1:5173 (proxies /api and /ws)
```

### Tests

```bash
npm test             # protocol unit tests + backend/simulator integration tests
npm run typecheck
```

### Docker

```bash
npm run setup        # or put ADMIN_PASSWORD=... in .env yourself
docker compose up -d --build
```

Data persists in the `fleet-data` volume. The port is bound to `127.0.0.1` only; see the comment in `docker-compose.yml` for LAN use.

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | — | dashboard password (required in production) |
| `HOST` | `127.0.0.1` | bind address |
| `PORT` | `8787` | |
| `DATA_DIR` | `./data` | SQLite database location |
| `PUBLIC_URL` | `http://127.0.0.1:8787` | address turtles use; shown in pairing instructions |
| `SECURE_COOKIES` | off | set `1` behind HTTPS |

## Minecraft side

Tested with MC 1.16.5, Forge 36.2.26, CC: Tweaked 1.100.2 and Advanced Peripherals 0.7.7 (FTB Ultimate Anniversary). The Lua agent avoids newer CC APIs. **CC: Tweaked blocks local addresses by default**: [docs/minecraft-setup.md](docs/minecraft-setup.md) shows the one narrow http allow rule to add, and covers chunk loading, fuel and GPS.

Then, on a mining turtle (create the code with **Add turtle** in the dashboard):

```
wget http://127.0.0.1:8787/turtle/install.lua install.lua
install ABCD-EFGH
```

## Docs

- [Architecture and strategy definitions](docs/architecture.md)
- [Wire protocol](docs/protocol.md)
- [Minecraft setup](docs/minecraft-setup.md)
- [In-game verification checklist](docs/in-game-checklist.md)
- [Progress notes](docs/progress.md)

## Milestones

1. ✅ Repository, backend, persistence, simulator, basic dashboard
2. ✅ Real Lua turtle pairing, telemetry, calibrated position, manual control (confirmed in-game)
3. ✅ One reliable tunnel job, automatic return, unloading and resume (in-game check pending)
4. ✅ Multi-turtle scheduling, groups, depot queues, collision handling (in-game check pending)
5. More strategies, formations, persistent 2D mapping (in progress: branch mine, grid mine, quarry, wall scanning, ore-vein following and ore search done; formations next)
6. 3D view and optional mapping integrations (in progress: 3D view done)
