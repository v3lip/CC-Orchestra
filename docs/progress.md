# Progress notes

## Milestone 6, part 1 — 3D view (2026-10-18)

- **2D | 3D switch** at the bottom right of the map. The 3D view (three.js, loaded only when opened: the main bundle is unchanged) shows what turtles have seen in an 80×80 area around the focused turtle, from 28 blocks below to 12 above it: blocks as cubes in the map colours (blocks enclosed on all sides are skipped), ores lit up, water and lava see-through, turtles in their status colour with a nose for the heading and a name tag, job areas as outlines (running ones bright), routes in yellow, the depot dock and waiting spots in green, and the job being drafted in amber.
- **X-ray** fades ordinary blocks so ores and tunnels stand out. **Cut above Y** hides everything above the Y slider, to look down into tunnels. **Re-centre** goes back to the focused turtle; selecting another turtle far away, or "show on map" in the Ores tab, moves the 3D area too.
- Mouse: left-drag orbit, right-drag pan, wheel zoom; click a turtle to select it (shift to add); hover a block to see its name and coordinates; double-click a block to orbit around it.
- Data comes from the same map cache as the 2D map (loaded by chunk and 16-high bands), so live updates from turtles appear in both.
- Checked on a test instance with three turtles sharing a quarry with wall scanning.

**Limitations**

- Only blocks turtles have seen exist; everything else is empty space, not "unknown".
- One 80×80 area at a time (moves with the focused turtle).

## Milestone 5, part 2 — head-on passing, grid mine, ore search (2026-10-18)

In-game, the user saw turtles bump into each other when one was heading home and another was walking towards it. Before this, turtles only noticed each other when nose to nose, then waited, detected the deadlock and backed off.

- **Agree who goes around, early:** a turtle checks 5 cells ahead; if a more important turtle (earlier job start) is coming the other way, it takes a parallel path (the other row of a 2-high tunnel, a neighbouring column) or pulls into a side cell before they meet. Activity log: *takes a parallel path to pass …* / *steps aside …*. Fixed along the way: an agent's stored route included cells it had already walked, so "where is it heading" looked at the past.
- **Grid mine** strategy: parallel tunnels every N blocks across an area, joined at alternate ends (the "Grid" tab in New job).
- **Ores tab:** every ore seen and not mined, grouped by type and vein, nearest first; click to jump the map there. Server: `GET /api/map/ores`.
- Tests: head-on in a corridor with a 2-high passing bay (the one giving way takes the other row; no failed moves, no stepping aside; the test fails with the old code); grid mine geometry (tunnels, passages, rock between); ore search (modded ores included, stone and mined cells excluded). Also run on a test instance: grid mine with wall scanning, Ores tab and jump-to-vein.

**Limitations**

- Who gives way is by job start time, not by who has an easier way out.
- Branch and grid mines can't be split between turtles yet (formations).


## Modded ore names (2026-10-18)

Ore filters were substring matches on the id, so they missed ores named the other way round (Immersive Engineering's `ore_copper`), and a custom filter typed like the in-game name ("Coal Ore") never matched; the custom field also split on spaces. Emendatus Enigmatica ores (`emendatusenigmatica:coal_ore`, …) did already match: the real map shows EE redstone being followed by vein following.

- Matching is now word-based and case-insensitive (`oreMatches` in the protocol package): "Any ore" = any id containing the word `ore`/`ores` (plus ancient debris); a material (`coal`, `Coal Ore`) matches that ore from any mod; `mod:block` is exact. The custom field is comma separated.
- Modded ores get the colour of the vanilla ore of the same material on the map.
- Tests: ore matching unit tests (vanilla, EE, IE-style ids, look-alikes like `charcoal_ore` and `core_block`).

## Turtles follow only their own veins (2026-10-18)

In-game, miners went after ores other turtles had seen (vein following looked at every ore in the shared map, and other turtles' tunnels made them reachable). Now a turtle follows only ores it saw itself during the current job (map `source` = its id, observed after the job was created). Test: a diamond seen only by another turtle, reachable through that turtle's passage, is left alone while the turtle's own find is mined (the test fails with the old code).

## Waiting near the dock without waiting spots (2026-10-18)

In-game, turtles that found the dock busy waited at the far end of their tunnels until it was free, then started the long walk home. The depot had no waiting spots, and without one a turtle waited where it was.

- A returning turtle now walks to ~6 steps from the dock before asking for it, so whoever gets there first docks first (before, a turtle far away could hold the dock for its whole walk back).
- With no free waiting spot, it waits on its own route as close to the dock as possible, off the docking turtle's way in (or the nearest known-free cell off it). Configured waiting spots are still used first.
- Test: two turtles with tunnels 14 blocks out and no waiting spots; the waiting one stays within 8 blocks of the dock (it waited 18 blocks out before the change).

## Milestone 5, part 1 — branch mine, quarry, wall scanning, vein following (2026-10-18)

**Implemented**

- **Branch mine** (corridor ≤3×3 with 1-wide branches every S blocks, left/right/both) and **Quarry** (W×L box, D deep, top down in ≤3-row layers). Strategies are described as ordered tunnel sections; runner, estimate, conflict checks, chunk list and map drawing all work on sections. Quarries can be shared between turtles as lanes.
- **Scan the walls** (job option): looks at every block around the work area (both side walls on every row, ceiling, floor, far end), so the map shows what's there.
- **Follow veins** (job option): pick ores (Diamond, Emerald, Gold, Iron, Redstone, Lapis, Coal, Ancient debris, Any ore, or custom ids). When a matching ore is seen outside the work area within reach (default 6), the turtle mines the vein, looking around each block, then comes back. Only the matching ore is dug outside the work area. Max blocks per vein: 48 by default.
- **Finds**: the job card lists the ores mined (◆ coal ore ×7 …) and how many came from veins. Map **◆ Ores** overlay: ore blocks within 8 levels of the current Y, labelled with the level difference.
- Job form rewritten: Tunnel / Branch mine / Quarry tabs with their own default sizes, and a "Finding ores" section.

**Verified — outside Minecraft only**

`npm test`: new tests for branch mine geometry (corridor and branches cleared, stone between branches); quarry layers; wall scanning (both wall rows, ceiling, floor and the end of a 1×2 tunnel are mapped); a 4-block diamond vein beside a tunnel (mined, finds 4, vein blocks 4, surrounding stone intact, diamonds unloaded).
Also run on a test instance from the dashboard: an 8×8×20 quarry with wall scanning and "Any ore" completed (coal ×7, iron ×3, 2 of them from veins).

**Limitations**

- Wall scanning only sees blocks next to the work area. Ores further in are found only by following veins from ones it saw.
- Vein following runs between stations, so a long vein delays the tunnel; reach limits how far it strays.
- Time and fuel for vein detours aren't in the estimate (a warning says so).

## Chunk borders: one unexplained drop, auto-resume (2026-10-18)

In-game, a turtle with a Chunk Controller went offline once, exactly as it stepped from chunk (−15,−14) into the next one on a long trip home, and came back by itself a minute later. Minecraft logged nothing. My first conclusion (the Controller can't cross borders) was wrong: chunky turtles have worked 500+ blocks away, crossing many borders. The cause is still unknown; the user suspects the chunk load not keeping up on the long walk back.

- **Opt-in auto-resume** (job policy): a job paused because its turtle dropped resumes when the turtle reconnects, within 15 min, at most 3× per hour, only with a known pose and no hold, and never after an operator pause.
- **Disconnect close codes** are now logged, to tell a computer shutdown from a dropped link next time. AP's `enableDebugMode` logs its force-loads.

- **Mark force-loaded chunks** on the map (**▦ Chunks → Mark force-loaded…**, click to toggle). Stored in SQLite (migration 3) and shared live. CC Fleet can't detect FTB Chunks' force-loads itself.
- **Chunks a job uses:** the estimate returns the tunnel footprint, the dock, and the chunks on the line between them, with marked/unmarked status. The form outlines unmarked ones (informational, no warning).
- **Crossing note:** if a job's turtle disconnects right at a chunk border, the pause reason says *went offline as it crossed from chunk A into chunk B*. Routes now include the start cell so "just crossed" is recognised.
- Docs: why the Controller isn't enough, FTB Chunks setup, and the Esc/alt-tab pause gotcha (F3+P).
- Tests: 58 (estimate chunk coverage and marking; diagnosis when the link drops at a border).

## Milestone 4 — multi-turtle scheduling, traffic, depot queues ✅ (2026-10-18; in-game check pending)

**Implemented**

- **Traffic control** (`traffic.ts`): per-move cell reservations (no shared cells, no head-on swaps), a wait-for graph, and deadlock resolution: the least important turtle steps into nearby known-free space off the other's route. If nobody can, the job stops with `deadlock` instead of hanging. Turtles nobody drives (manual, idle, offline) are walls; moving agents are expensive cells.
- **Mover** (`mover.ts`): movement extracted from the job runner and shared by jobs and go-to tasks: planning, reservations, yielding, gravel retries, unknown-obstruction inspection.
- **Dock waiting spots**: the depot form gets a list of spots. A turtle finding the dock busy waits on the nearest free spot; the dock is held only while a turtle heads in or stands on it (no longer the whole corridor). Waiting spots are drawn on the map.
- **Campaigns**: create several jobs at once, validated all-or-nothing. Either one tunnel per turtle, or **one tunnel split into lanes**, one per turtle, assigned left to right; the form previews the lanes and starts them in front of the leftmost turtle. Campaign card with combined progress and Start/Pause/Cancel all; plus pause/resume for the jobs of the selected turtles.
- **Go to**: send one turtle to a coordinate through known space (no digging) under traffic rules.
- `fleet.importObservations` for map data from other sources (tests now, scanner adapters in Milestone 6).
- Shutdown stops tasks and jobs before the database closes (no work after shutdown).

**Verified — outside Minecraft only**

`npm test`: 56 tests. New: traffic unit tests (reservations; cycle detection, victim choice, `stuck`); head-on in a 1-wide corridor with an alcove (one steps aside, both arrive, never in the same cell); the same without an alcove (deadlock reported, no hang); a 4-wide tunnel split into 2 lanes (both complete, every cell cleared); all-or-nothing campaign validation; two turtles queueing on a waiting spot, with group pause and resume. The existing 47 still pass after the refactor.
Also clicked through on a test instance: a 3-turtle shared tunnel (lanes previewed in front of each turtle), the campaign card, Pause all / Resume all, waiting spots on the map.

**Limitations**

- Stepping aside only uses cells already known to be free. Turtles map only what they move through and inspect (front/up/down), so a side alcove has to have been seen.
- Priorities are by job start time, not by urgency (e.g. low fuel).
- Lanes split the width only; height or length splits (and quarries) come with Milestone 5's strategies.

## Chunk loading visibility (2026-10-18)

- Agent `lua-0.3.1` / `sim-0.3.1` reports each upgrade side's peripheral type (`state.upgrades`). An Advanced Peripherals Chunk Controller reports `chunky`. This was verified from the installed AP 0.7.7.1r jar: `ChunkyPeripheral.TYPE = "chunky"`. It force-loads the turtle's current chunk via ForgeChunkManager, refreshed each tick, expires after `chunkLoadValidTime` (600 s), and persists across server restarts.
- Dashboard: CHUNK badge, an upgrades & chunk-loading section in the details panel, and a job-card note for turtles without a Controller. The estimate warns too.
- Map **▦ Chunks** overlay: chunk grid; "kept loaded" (online chunky turtle), "loaded now" (an online turtle is active there), and "chunky turtle offline" (last known chunk). Chunks loaded by players or other mods (FTB Chunks) aren't visible and the legend says so.
- `npm run sim -- --chunky` equips simulated turtles with a Controller.
- Tests: 49 (agent reports upgrades; estimate warning).
- **In-game result:** a chunky turtle shut down when it crossed into the next chunk with no player near. It works within one chunk but can't carry a turtle across borders (probably because neighbouring chunks don't tick block entities on 1.16). See the follow-up below.

## Milestone 4, part 1 — several turtles, one depot (2026-10-18)

Prompted by in-game use: Milestone 3 worked for one turtle, but multi-selecting turtles for jobs was clunky.

- Job form: with several turtles selected, it creates one tunnel per turtle, each starting in front of its own turtle in its facing, all the same size. A list shows each origin; turtles without a known pose, or that already have a job, are skipped with the reason. Overlaps (between the new tunnels, or with unfinished jobs) are flagged and block creation. One button creates and starts all. Single-turtle mode defaults to "start in front of the turtle", so there are no coordinates to type.
- Server: refuses overlapping job volumes. Shared-depot queue: the dock is held from leaving the tunnel until back in it, waiting is visible, there is no 2-minute timeout, and finished turtles park in their own tunnel when others still need the dock. A job paused mid-trip resumes with the trip back rather than another unload.
- Robustness: when a move is blocked by something the map doesn't know yet, the runner inspects it instead of waiting forever. This was found with turtles starting right against rock. The simulated agent now inspects after a blocked move and on connect, like the Lua agent.
- Tests: 47. New: overlap rejection, and two turtles taking turns at one dock with mid-job trips (no shared cell, nothing spilled, lock freed at the end). Checked by hand: three simulated turtles, one form, three parallel tunnels, queueing at the dock and completing.

Still Milestone 4: cell/edge reservations so turtles can share corridors at the same time (today the depot approach is one-at-a-time and the rest relies on re-planning around turtles), dock waiting positions, splitting one big volume into lanes, and group-level job controls.

## Milestone 3 — tunnel job, automatic return, verified unloading, resume ✅ (2026-10-18; in-game check pending)

**Implemented**

- Jobs: persisted (SQLite migration 2), lifecycle ready/running/pausing/paused/completed/cancelled, checkpoint per slice, resume after pause/disconnect/backend restart (never automatic).
- Tunnel strategy (W×H×L from an origin and heading) with serpentine lanes (one pass clears 3 rows), exclusions, and progress (slices, cells, skipped, trips, items).
- Navigation: A* over observed map knowledge. It digs only inside the job volume, never protected blocks, and treats other turtles (offline included) and depot chests as walls. Bounded re-planning and gravel retries.
- Depots: dock cell + heading, unload chest side, optional fuel chest side; dock lock (held while a turtle is offline there).
- Service trips: inventory threshold and fuel-to-get-home checks; verified unloading (fuel slot and keep slots preserved); fuel-chest top-up, with non-fuel returned; carried fuel burned only when needed; insufficient fuel stops the job at the dock.
- Agent 0.3.0 (Lua and simulated): verified `drop` (refuses without an inventory, checks counts), `suck` (inventories only), `inventoryInfo`, and a dig guard (never digs inventories; protected-name list unless `force`). Jobs refuse agents older than 0.3.0.
- Manual command / stop / cancel on a turtle pauses its job after the current step.
- Dashboard: Turtle/Jobs/Depots tabs; depot form ("use this turtle as the dock") with setup guidance; tunnel form ("start in front of the turtle"), policy, live estimate and warnings; job cards with progress, errors and controls; map overlays for depots, tunnel outlines and progress, draft preview, and planned route. The turtle status shows working/returning/unloading from the job phase.
- Turtle message rate limit raised from 60/s to 300/s. In-game, back-to-back one-tick ops (inspect, drop) could exceed 60/s.
- `npm run sim` creates a ready depot site (chest west of the first turtle, fuel chest with coal under it).

**Verified — outside Minecraft only**

`npm test`: 45 tests (15 new for jobs). TS agent: 1×2×8 tunnel and unload; 3×3×6 with mid-job trips, resume and fuel slot kept; missing chest (pauses, **no items spilled**, resumes after fixing); full chest (partial transfer detected); protected block never dug; gravel column; manual takeover then resume; disconnect then resume; refuel from a fuel chest; insufficient fuel (stops at home); backend restart then resume from checkpoint. Real Lua agent: tunnel with verified unloading and fuel slot kept; missing chest (no spill); agent refuses to dig an inventory even with `force`. Plus the agent version gate.
Also clicked through by hand on a separate test instance: depot form, job form with map preview and estimate, a 1×2×32 job running, returning and completing, with the route and progress drawn on the map.

**Not verified:** in-game. The key unknown is whether `peripheral.wrap("front"/"top"/"bottom")` exposes the adjacent chest's inventory on your CC: Tweaked 1.100.2 turtle. If it doesn't, unloading refuses (safely) and the job pauses with "No chest". Checklist step 2 confirms it.

**Known limitations**

- One turtle per job. Multi-turtle partitioning, dock queues/waiting positions and cell reservations are Milestone 4.
- Estimates are rough (assume rock, ~640 blocks per trip).
- Return-home cost uses Manhattan distance × 1.25 + 10, not the real path length. Keep `fuelReserve` generous for winding routes.
- Fluids are walked through, not sealed. Lava flowing into a tunnel isn't handled specially.
- The route to and from the dock must be open: travel never digs outside the job volume. A blocked route pauses with `no_route`.

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

## Next: Milestone 4 — multi-turtle scheduling, groups, depot queues, collision handling

Split a job into lanes or work units per turtle, with ownership. Cell and edge reservations between turtles (no head-on swaps, deadlock detection in narrow corridors). Depot queue with waiting positions. Group-wide job start/pause.
