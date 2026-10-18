# Architecture

```
 Browser (React)  ──HTTP + /ws/ui──►  Backend (Fastify, Node 24)  ◄──/ws/turtle──  Turtles (Lua agent)
                                         │  Fleet model, queues, stops,           ◄──/ws/turtle──  Simulator (TS)
                                         │  planner (M3+), map store
                                         ▼
                                      SQLite (node:sqlite, WAL, migrations)
```

## Key decisions

**The backend plans; turtles carry out atomic steps.** A turtle runs only whitelisted primitives (move, turn, dig, inspect, select, refuel, calibrate, GPS). Mining strategies, routing, reservations and depot queues live in the backend (Milestone 3+). This means:

- one source of truth for planning, which is easy to test with the simulator
- "stop when the connection is lost" is the natural default, because a disconnected turtle has nothing to do
- the trade-off is one round trip per step. A turtle move takes ~400 ms (8 ticks) and a localhost round trip takes milliseconds. If this becomes a bottleneck, a later milestone can add short, bounded step sequences that the turtle aborts when the link drops.

**Two-sided single-executor rule.** The server dispatches one command per turtle at a time. The agent also rejects anything that arrives while it is busy or held. Manual commands and (later) jobs both go through the same per-turtle queue, so manual control will pause a job, never interleave with it.

**Never guess.** Unknown outcomes stay `unknown` until the turtle's own persisted record or physical evidence (fuel) settles them. A turtle with an uncertain position is shown as uncertain, with its candidate cells.

**Offline ≠ gone.** An offline turtle keeps its last known position on the map, drawn as a dashed "still an obstacle" marker. Milestone 4's reservation system will treat it as occupied until it reports in.

**Map = observations only.** A row exists only for cells actually seen (inspected or moved into). Absent = unknown, which is drawn differently from known air. Data is stored per (world, dimension, x, z, y). The dashboard loads it per 16×16 chunk and 16-block Y band, then receives incremental deltas.

## Packages

| Path | What |
|---|---|
| `packages/protocol` | zod schemas, constants and helpers shared by backend, simulator and dashboard |
| `apps/server` | Fastify app: auth, REST, `/ws/ui`, `/ws/turtle`, Fleet model, SQLite |
| `apps/sim` | voxel world + simulated turtle agent; CLI to run N turtles |
| `apps/web` | React + Vite + Tailwind dashboard |
| `turtle/` | Lua agent (Milestone 2); served at `/turtle/` |

## Security

- Dashboard: one admin password (`ADMIN_PASSWORD`) → random session token in an HttpOnly, SameSite=Strict cookie (hashed in the DB, 7-day expiry). Login is rate-limited.
- Turtles: one-time pairing codes (15 min, hashed, single use) → per-turtle secret (hashed). Removing a turtle revokes it.
- Commands are validated against the op whitelist; there is no remote Lua execution.
- The backend binds `127.0.0.1` by default. Expose it on a LAN only deliberately, and pair that with a narrow CC: Tweaked http rule (see `minecraft-setup.md`).

## Mining strategy definitions (planned for Milestones 3 and 5; fixed here to avoid ambiguity)

| Strategy | Definition |
|---|---|
| **Tunnel** | Excavate a W×H cross-section along a straight line of length L from an origin and heading. |
| **Branch / strip mine** | A main corridor (W×H, length L) along the heading. Every S blocks, side branches of length B leave both sides, perpendicular to it. Branch cross-section is configurable (default 1×2). Branch spacing S is measured between branch centrelines. |
| **Grid mine** | Parallel 1×2 tunnels covering a rectangle at one target Y, spaced S apart (default 3, so every block is exposed to a tunnel face). |
| **Quarry** | Remove every block in an axis-aligned box [x0..x1]×[y0..y1]×[z0..z1], top layer first. |
| **Layer clear** | A quarry restricted to the given Y layers (e.g. flattening an area). |
| **Vein follow** (later) | From an observed ore block, mine connected blocks of the same ore that turtles actually inspect, within the job boundary. |

Multi-turtle jobs will be split into non-overlapping work units (lanes or sub-boxes). Each unit has an owner and a persisted checkpoint, so a reconnecting turtle resumes its own unit instead of duplicating work.
