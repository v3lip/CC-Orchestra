# Progress notes

## Milestone 2 — Lua agent, pairing, telemetry, calibration, manual control ✅ (2026-10-18; in-game check pending)

**Implemented**

- `turtle/fleet/agent.lua` (Lua 5.1 syntax, CC: Tweaked 1.100.2 APIs only). It runs four `parallel` coroutines (network, executor, heartbeat, status screen):
  - enrollment with a one-time code, then per-turtle credentials; labels the turtle so it keeps its files
  - hello with the persisted recent-command record; snapshots after every state change; heartbeats; 20 s link watchdog; reconnect backoff 1 s to 30 s with jitter
  - whitelisted ops only, with argument validation and expiry checks repeated on the turtle side; busy/held refusal; duplicate detection
  - movement journal written before each move/turn, and fuel-evidence reconciliation on boot. An interrupted turn makes the heading uncertain.
  - hold (pause/e-stop) persisted across reboots; a stop that arrives before a command starts makes it fail with `held`
  - scan on move (inspect front/up/down) plus a boot scan, so the map grows as turtles move; other turtles are never mapped
  - every vector is copied before saving, because CC 1.100's `serializeJSON` rejects a table referenced twice
  - crash-safe state file (temp file plus sequence number)
- `turtle/install.lua`: checks the http rule, downloads files from the manifest, preserves a foreign `startup.lua`, writes the config, accepts the pairing code, offers calibration, supports update/re-pair
- Backend: `/turtle/install.lua` (URL baked in) and `/turtle/manifest.json`; resume results no longer hang when a turtle disconnects before confirming
- `apps/sim/src/cc`: CC-like host (wasmoon Lua 5.4) that runs the **real** agent and installer against the simulated world; `npm run sim -- --lua`
- Simulator physics split into `physics.ts`, shared by both simulated agents
- Pairing dialog shows the real install commands

**Verified — outside Minecraft only**

`npm test`: 30 tests. Twelve run the real Lua files: a Lua 5.1 syntax check, install and pairing, uncalibrated install then calibration, re-install keeps identity, move/obstruction/dig/inventory/map, agent-side validation of bad args, unknown ops and expired commands, duplicate delivery, e-stop held across reboot then resume, reboot mid-move (fuel evidence), unlimited-fuel uncertainty then GPS fix, GPS without a modem, and link loss after the ack then reconciliation.
Also checked by hand: three real-agent turtles installed via `npm run sim -- --lua` and driven from the dashboard.

**Not verified**: behaviour in CC: Tweaked's Cobalt VM and in Minecraft (tick timing, real inspect data, chunk unloading, real http rules). Use [in-game-checklist.md](in-game-checklist.md).

**Known limitations**

- The host's JSON and `fs` are reimplementations. Differences from CC (e.g. how numbers are formatted) would only show up in-game.
- No agent auto-update; rerun `install`.
- Test-worker crash: with both server test files in parallel, a vitest worker process died in 2 of ~35 runs (no assertion failed; native crash, cause not identified). Each file alone: 0 of 25. Test files now run sequentially (`fileParallelism: false`): 0 of 15 since.

## Milestone 1 — repository, backend, persistence, simulator, basic dashboard ✅ (2026-10-18)

**Implemented**

- npm-workspaces monorepo; shared, versioned protocol (`packages/protocol`, zod) with size limits and an op whitelist
- Backend (Fastify 5, `node:sqlite`, forward-only migrations):
  - dashboard login (session cookie); one-time pairing codes → per-turtle hashed credentials; revocation
  - turtle sessions: hello/welcome, snapshots, heartbeats, stale/offline detection, reconnect handling, superseded connections
  - per-turtle FIFO command queue with **one command in flight**; lifecycle `queued → sent → running → succeeded/failed/cancelled/rejected/expired/undeliverable/unknown`
  - group commands produce a batch with **per-turtle results**; offline targets are `undeliverable`, never silently dropped
  - emergency stop / pause / resume / cancel: stops after the current atomic op, acks tracked per turtle, offline turtles reported **unreachable** and stopped on reconnect
  - reconciliation of `unknown` outcomes from the turtle's persisted recent-command record (after a disconnect or a backend restart)
  - groups (CRUD, membership); event log; observed-block map store with adjacency validation and incremental deltas
- Simulator: deterministic voxel world (terrain, caves, ores, gravel, water/lava, bedrock), physical turtle bodies separate from agent memory, movement journal + fuel-evidence reconciliation, duplicate detection, holds, reconnect backoff, fault injection
- Dashboard: login, live WebSocket updates, 2D slice map (observed cells only, unknown drawn distinctly, floor hint, offline ghost markers, uncertain-pose candidates), click/box/shift selection, Y slider + follow, go-to search, fleet list with search/filters/groups, target strip showing exactly who a command reaches, manual movement/dig/inspect/utility controls (+ WASD/RF keys), E-STOP and STOP ALL, per-turtle results panel, activity log with actionable alerts, calibration form, inventory grid, pairing dialog
- Docker image + compose (backend serves the built dashboard)

**Verified (simulator only — nothing here has run in Minecraft yet)**

`npm test`: 18 tests. Covers enrollment and auth, pose tracking and map recording, obstruction, serial execution, partial group failure, head-on corridor conflict, duplicate delivery, e-stop with busy/idle/offline turtles plus delayed delivery and resume, reboot mid-move (fuel evidence and unlimited-fuel uncertainty plus GPS fix), connection loss before a result, stale → offline, and a backend restart with reconciliation.

Also exercised by hand in the browser against 6 simulated turtles: selection, keyboard driving, dig, per-turtle results, STOP ALL, backend restart with automatic turtle reconnect.

**Not implemented yet (planned)**

- Lua agent and installer (M2)
- Jobs, strategies, depot/unloading, return-home, refuel policies (M3)
- Reservations of cells and edges, deadlock handling, depot queues, multi-turtle scheduling (M4)
- Formations, more strategies, surface view (M5)
- 3D view, scanner adapters (M6)

**Known limitations**

- Single admin password; no per-user accounts.
- Map rendering is one Y slice; there is no surface view yet. A "highest observed block" is never treated as the surface.
- Simulator terrain is not real Minecraft terrain. Fluids don't flow, and gravel only falls into empty cells.
- Turtle movement in the simulator happens in parallel, which is optimistic compared with real tick timing.

## Next: Milestone 3 — one reliable tunnel job, automatic return, unloading and resume

Job model with persisted checkpoints. A server-side tunnel planner issuing atomic steps through the existing queue (manual control pauses the job). Depot setup (chest, dock, unload direction). Verified unloading via the chest's inventory peripheral (count before/after; never blind `drop`). Return when inventory or fuel crosses a threshold, then resume at the saved position.
