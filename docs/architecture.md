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

## Jobs (Milestone 3)

`apps/server/src/jobs/`: `manager.ts` (persistence, lifecycle, dock locks, hooks), `runner.ts` (execution), `nav.ts` (A*), `geometry.ts` (tunnel cells and stations).

- **Lifecycle:** `ready → running → (pausing →) paused ⇄ running → completed`, or `cancelled`. Pausing waits for the current step. A **manual command, stop or cancel** on the turtle, a **disconnect**, or a **backend restart** pauses the job; nothing resumes on its own. Problems the operator must fix pause the job with an `error {code, message}` (e.g. `chest_full`, `chest_missing`, `protected`, `insufficient_fuel`, `no_route`, `pose_uncertain`, `agent_outdated`).
- **Execution:** the runner issues the same atomic commands through the turtle's queue (executor `job:<id>`, not shown as UI batches) and reads the turtle's snapshots and the observed map after each step. It never assumes a step worked.
- **Tunnel plan:** each slice (one step along the heading) is a work unit. The turtle stands at lane rows `1, 4, 7…` (clamped to the height) and digs the rows directly above and below, visiting columns in a serpentine. Odd slices run in reverse so slices connect. **Checkpoint** = the next slice index, plus the resume pose while on a depot trip. Re-running a slice is harmless: cells already observed as air are skipped, and digging air is a no-op.
- **Navigation:** A* over observed cells: air 1, fluid 1.5, unknown 3, diggable solid 3. Only cells inside the job volume (minus exclusions, minus protected blocks) may be dug. Other turtles' last known cells (including offline turtles and uncertain candidates) and the depot chests are walls. Blocked moves re-plan (max 30). Falling blocks are re-dug (max 24 per cell). Unbreakable cells are skipped and counted.
- **Depot trips:** triggered when unreserved free slots ≤ `minFreeSlots`, or when fuel < estimated way home (Manhattan × 1.25 + 10) + `fuelReserve`, after first burning carried fuel. A trip: save the resume pose → path to the dock → take the dock lock → face the dock heading → `inventoryInfo` → verified `drop` of every slot except keep slots and fuel in the fuel slot → top up from the fuel chest (`suck` + `refuel`; non-fuel goes back and pauses the job) → burn carried fuel only if still short → check there's enough to get back → release the lock → return to the resume pose.
- **Dock:** one turtle at a time. A returning turtle first walks to about 6 steps from the dock, then asks for it (so whoever arrives first docks first); the lock is held from there until it steps off the dock. A turtle that finds the dock busy claims the nearest free **waiting spot** if the depot has one. Otherwise it picks a cell itself: the cell of its own route closest to the dock that the holder's way in doesn't use (never right next to the dock), or else the nearest known-free cell off that way. While waiting it steps aside if another turtle is waiting for it. A lock held by an offline turtle stays (it may physically be in the way). A job paused mid-trip keeps its dock/spot; resuming finishes the trip without unloading again. When other jobs share the depot, a finished turtle parks at its tunnel's origin instead of on the dock.
- **No overlapping jobs:** the server refuses a tunnel whose volume intersects an unfinished job's. Campaigns check all their jobs before creating any.

## Traffic (Milestone 4)

`apps/server/src/jobs/traffic.ts` and `mover.ts`. Every server-driven turtle (job or go-to task) is a traffic **agent**.

- **Cell reservations:** before each move a turtle reserves the cell it is about to enter. A cell is taken if any turtle stands in it (including offline turtles and the candidate cells of turtles with an uncertain position) or another agent has reserved it. Turtles only enter free, unreserved cells, so two turtles can't end up in one cell or swap places head-on. Reservations are released after the move (success or failure).
- **Planning around others:** turtles nobody is driving (manual control, idle, offline) are walls for the path planner. Agents' cells and reservations are only expensive (+12), because they will move on. The reservation decides who goes first.
- **Waiting and deadlocks:** a blocked turtle records whom it waits for. Behind a turtle nobody drives it re-plans after 3 s; behind an agent it waits up to 30 s. A cycle in the wait-for graph is a deadlock. The member with the lowest priority (latest start) that can still move aside steps into the nearest known-free cell off the other's route (searching up to 16 blocks), waits for it to pass, then re-plans. If nobody can step aside, the job/task stops with error `deadlock` (move one turtle by hand). Stepping aside needs known free space: tunnel lanes, alcoves, the area around the dock. Turtles only map the cells they move through and inspect (front, up, down).
- **Campaigns:** several jobs created together, either one tunnel per turtle, or one tunnel **split into side-by-side lanes** (one per turtle, assigned left to right by position so paths don't cross; at most one turtle per column). Start, pause or cancel apply to the whole campaign; there are also start/pause actions for the jobs of any set of turtles (selection or fleet group).
- **Go to:** drives one turtle to a cell through known space under the same rules, never digging. Manual commands, stops and disconnects end it.

## Mining strategies

Every strategy is turned into an ordered list of **sections** (`segmentsFor`): plain tunnel boxes mined one after another. The runner, estimate, conflict checks, chunk list and map all work on sections, so a new strategy only has to describe its sections. A job's checkpoint counts slices across all sections.

| Strategy | Definition | Sections |
|---|---|---|
| **Tunnel** ✅ | Clear every cell `origin + d·forward + w·right + h·up` for `0≤d<L, 0≤w<W, 0≤h<H`. The origin is the bottom-left cell of the first slice when looking along the heading. | one |
| **Branch mine** ✅ | A corridor (W×H ≤3×3, length L) along the heading. Every S blocks (S, 2S, …) a 1-wide branch of the corridor's height and length B leaves the left side, the right side, or both. | corridor parts between branch points, each followed by its branches |
| **Quarry** ✅ | Remove every block of a W×L box, D deep, going down from the origin (top-left of the top layer). Also for flattening. | one per layer of ≤3 rows, top down |
| **Grid mine** (planned) | Parallel 1×2 tunnels covering a rectangle at one Y, spaced S apart. | |

Tunnels and quarries can also be **shared** between turtles: split into side-by-side lanes (campaign), one per turtle.

### Seeing what's around: wall scanning and vein following (job policy)

- **Scan the walls** (`policy.scanWalls`): at each column the turtle looks at every outer face of the work area it hasn't seen yet: side walls on the first/last column, end walls on the first/last slice, the ceiling and the floor. It visits each row of the column (moving in already looks up and down), turns and inspects, then returns to the column's station. Inner faces (next to other parts of the work area) are skipped. Costs about 2 vertical moves per column plus turns.
- **Follow veins** (`policy.veins = {ores, maxBlocks, reach}`): after each station, the runner looks in the map for blocks its own turtle saw during this job (the map's `source` is that turtle and the sighting is newer than the job; ores other turtles reported are ignored) matching any of `ores` (`oreMatches`: word-based and case-insensitive, so `coal`, `coal_ore` or `Coal Ore` match `minecraft:coal_ore`, `emendatusenigmatica:coal_ore` and `x:ore_coal`; `any`/`_ore` matches any id with the word `ore`/`ores`; `mod:block` is an exact id) outside the work area but within `reach` blocks of it. It goes to the nearest one, mining only that block (`canDig` allows matching ore outside the work area, nothing else), inspects the sides around it, and repeats until nothing reachable is left or `maxBlocks` were mined. Then it returns to where it left the tunnel. Unreachable ores are skipped.
- **Finds**: every ore the turtle digs (the agent reports the block it dug) is counted in `progress.finds`; ores mined outside the work area also count in `progress.veinBlocks`. The job card shows them, and the map's **◆ Ores** overlay marks ore blocks seen within 8 levels of the current Y.

Multi-turtle jobs will be split into non-overlapping work units (lanes or sub-boxes). Each unit has an owner and a persisted checkpoint, so a reconnecting turtle resumes its own unit instead of duplicating work.
