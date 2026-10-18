# Progress notes

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

## Next: Milestone 2 — Lua agent, pairing, telemetry, calibration, manual control in-game

Same protocol as the simulator: `startup.lua`, an installer that checks the http rule with `http.checkURL`, persisted credentials/journal/recent/hold in `/fleet/`, a `parallel` network/executor/heartbeat design, and an in-game verification checklist.
