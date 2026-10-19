# Milestone 6 — Geo Scanner mapping and 3D view upgrades

**Goal:** see far more of the world without digging, and make the 3D view useful at the scale turtles now map.

Scope agreed on 2026-10-19:

1. **Geo Scanner mapping**: turtles with an Advanced Peripherals Geo Scanner fill the map and the Ores tab.
2. **3D view upgrades**: a bigger area with level of detail, an overview inset, and better job/route display.

Already done before this milestone: the 3D view itself (x-ray, Y cut-off, picking, overlays).
Moved to a later milestone: formations (splitting branch/grid/quarry jobs between turtles), minimap waypoints (JourneyMap / Xaero).

---

## Part A: Geo Scanner mapping

### Facts (from the installed AP 0.7.7.1r and its config)

| | |
|---|---|
| Peripheral type | `geoScanner` (turtle upgrade or block) |
| Methods | `scan(radius)`, `cost(radius)`, `chunkAnalyze()`, `getMaxCostRadius()`, … |
| Result entries | `name`, `tags` (Forge tags, e.g. `forge:ores`), plus the block's position |
| Free radius | 8 blocks (`scanBlocksMaxFreeRadius`) |
| Max radius | 16 blocks (`scanBlocksMaxCostRadius`); beyond 8 costs 0.17 per extra block, paid from the turtle's fuel (`attachFuel`) |
| Cooldown | 2 s between scans (`scanBlocksCooldown`) |

**Verify in-game before building on them** (step A0):

- Are result positions relative to the scanner? (Expected: yes.)
- Is the scanned volume a cube or a sphere of the radius, and is air left out? This decides which cells can be marked "known empty".
- What does a turtle-mounted scanner cost in fuel at radius 8 and 16?

### Design

- **Agent** (`agent.lua`, new op `geoScan {radius}`): finds the `geoScanner` peripheral, calls `scan(radius)`, converts positions to world coordinates with the turtle's known pose, and reports them as observations in batches of ≤256 (the existing per-message limit, `MAX_OBSERVATIONS_PER_MESSAGE`; 64 KiB per message). Returns a count and the cost. Refuses with `no_scanner` if none is equipped, `cooldown` if called too early. The upgrade is shown in the turtle's details like the Chunk Controller.
- **Protocol**: observations from a scan are marked `source: 'scan'` with the scan's centre and radius. The server's "only cells next to the turtle" check is relaxed for these to "within the radius of the turtle's known position".
- **Server**:
  - Ingest scans into the map (same table; one scan can be several thousand cells: insert in one transaction).
  - If A0 shows the scan covers a full cube/sphere with air omitted, mark unreported cells in that volume as known empty (else only record the blocks).
  - Keep the tags: `isOreBlock` also accepts blocks tagged `forge:ores` (catches modded ores whose ids have no "ore" in them).
- **Jobs**: new policy option **Geo scan every N blocks** (default off; N = 8 at radius 8). Runs between slices, respects the cooldown, and counts its fuel cost in the estimate. Vein following then works from scanned ores too (still only ores the job's own turtle saw).
- **Dashboard**:
  - Right-click menu → **Geo scan here** (selected turtle with a scanner, radius 8 / 16).
  - Scan results show up in the 2D map, 3D view and the Ores tab like any other observations.
  - Map legend notes scanned areas.
- **Simulator**: a `geoScanner` upgrade for sim turtles (scan the sim world within the radius, same result shape and cooldown), so everything above is testable without Minecraft.

### Steps

| | Step | Done when |
|---|---|---|
| A0 | In-game probe: run `scan(8)` once from the Lua prompt on a turtle with a scanner; note result shape, coordinates, air, cost | facts above confirmed or corrected in this doc |
| A1 | Protocol + server: scan observations, wider acceptance radius, transaction insert, `forge:ores` tag | unit tests: a scan is stored, far observations still rejected, tag-only ore detected |
| A2 | Simulator geo scanner upgrade | sim test: scanning reports the right blocks, cooldown enforced |
| A3 | Agent op `geoScan` (Lua) + upgrade detection | Lua agent test in the CC test host |
| A4 | Job policy "Geo scan every N blocks"; estimate includes cost | job test: ores beside the route are found and followed without wall scanning |
| A5 | Dashboard: right-click "Geo scan here", details panel, legend | browser check on a sim instance |
| A6 | In-game checklist steps; docs | user confirms in-game |

---

## Part B: 3D view upgrades

### Today

- An 80×80 area, 28 blocks below to 12 above the focused turtle, rebuilt (throttled) on map updates.
- Job outlines, routes of running jobs and the job being drafted are already drawn.

### Design

- **Bigger area with level of detail:**
  - Meshes per 16×16 chunk column instead of one mesh for everything, so a map update only rebuilds the chunks it touched.
  - The area grows to about 256×256.
  - Chunks far from the camera draw only their top surface and ores; full detail near the centre.
  - Cap the instance count, with a note in the toolbar when detail was reduced.
- **Overview inset:** a small top-down map in a corner showing where the 3D box is, the turtles and depots; click it to move the box.
- **Jobs and routes:**
  - Show finished parts of a job (dug slices) differently from what's left.
  - Draw the planned route of a turtle on a go-to, not only of jobs.
  - Optionally a 3D outline of the whole job area while it's being set up in the job form (already there for the draft; extend to branch/grid previews).
- **Camera:** "follow turtle" toggle; keyboard shortcuts for x-ray / cut.

### Steps

| | Step | Done when |
|---|---|---|
| B1 ✅ | Chunk-column meshes, incremental rebuild | test: an update touching one chunk rebuilds one mesh; benchmark of a full 256×256 area stays interactive. **Done 2026-10-19:** area 256×256; with the real map (31k cells) a full rebuild takes 15 ms and a map update 0.2 ms (was 43 ms per update). Fully mapped worst case: update 8 ms, full rebuild 2.5 s → B2 |
| B2 | Level of detail and instance cap | benchmark with a dense mapped area; toolbar shows reduced detail |
| B3 | Overview inset | browser check: click moves the 3D box |
| B4 | Job progress in 3D, go-to routes | browser check on a sim instance with a running job |
| B5 | Follow-camera, shortcuts | browser check |
| B6 | Docs, checklist | user confirms in-game |

---

## Verification

Each step: tests first where the behaviour can be pinned down, then the full suite, typecheck, build, a sim scenario, and a browser check for UI work. Results in `progress.md` keep "tested in the simulator" and "confirmed in-game" apart, as before.
