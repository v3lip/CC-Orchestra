# CC Fleet

Self-hosted fleet management for CC: Tweaked mining turtles: a browser dashboard, a Node backend, and (from Milestone 2) a Lua agent on each turtle.

> **Status: Milestone 1.** Backend, persistence, simulator and dashboard work and are tested **against the simulator**. The in-game Lua agent comes in Milestone 2. See [docs/progress.md](docs/progress.md).

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

Simulator options: `--count N`, `--speed 2` (faster ops), `--reset` (fresh world and turtles), `--no-calibrate` (start with unknown pose), `--no-gps`. Simulated turtles are registered in the world `sim`, so their map never mixes with real data. They are marked **SIM** everywhere.

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

Your instance: MC 1.16.5, Forge 36.2.26, CC: Tweaked 1.100.2. **The world's http rules currently block local addresses.** [docs/minecraft-setup.md](docs/minecraft-setup.md) shows the one narrow allow rule to add, and covers chunk loading, fuel and GPS.

## Docs

- [Architecture and strategy definitions](docs/architecture.md)
- [Wire protocol](docs/protocol.md)
- [Minecraft setup](docs/minecraft-setup.md)
- [Progress notes](docs/progress.md)

## Milestones

1. ✅ Repository, backend, persistence, simulator, basic dashboard
2. Real Lua turtle pairing, telemetry, calibrated position, manual control
3. One reliable tunnel job, automatic return, unloading and resume
4. Multi-turtle scheduling, groups, depot queues, collision handling
5. More strategies, formations, persistent 2D mapping
6. 3D view and optional mapping integrations
