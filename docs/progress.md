# Progress notes

## Notifications (2026-10-23)

- Set `NOTIFY_WEBHOOK_URL` (a Discord or Slack webhook) and the backend posts a message when a job completes ("✅ [world] Turtle: "Job" completed: N blocks, M ores. Next in the queue: …"), needs attention (the same reason the job card shows), or pauses because its turtle went offline or stopped answering. An operator's own pause sends nothing.
- One message at a time, at least 1.2 s apart; a burst of more than 20 becomes "…and N more"; a webhook that fails is reported in the activity log once (and when it works again). The Activity tab says whether notifications are on and has **Send a test**.
- Tests: the notifier (burst collapse, failure reported once, off without a URL); a real job's completion and a missing-chest problem reach a local webhook; the test button.


## Job queues (2026-10-23)

- A turtle can have jobs queued behind its current one: **Queue after the current job** in the job form (for single jobs and campaigns), new job status `queued`. When the current job completes, the next queued job starts by itself, in queue order; **Run next** moves a queued job to the front, **Start now** starts one with nothing ahead of it. After a cancel or a problem the queue waits for you.
- The next job starts only once the previous job's runner has fully ended (its clean-up leaves traffic control and frees the dock; done any earlier, it would undo the new job's set-up).
- Queued jobs count when checking for overlapping work areas, and keep their depot from being deleted.
- Tests: three jobs for one turtle run in queue order (with Run next), a second job for a busy turtle is refused unless queued, a queued job overlapping another is refused; after a cancel the queue doesn't move on by itself. Browser check: queue cards ("2nd in Sim 1's queue, after …"), and the next job started by itself when the first completed.


## Formations: sharing branch and grid mines (2026-10-23)

- **Share one** in the job form now works for every job type, not just tunnels and quarries. One shared function (`splitStrategy`) is used by the server and the form's preview:
  - tunnels and quarries: side-by-side lanes (as before);
  - grid mines: bands of whole tunnels, left to right by where the turtles stand;
  - branch mines: the turtle nearest the start digs the corridor, and the branches are dealt out in turn between all of them (two turtles: left and right branches). New optional branch params `corridor: false` and `branchIds`.
- A turtle whose next station can't be reached yet (its branch, before the corridor gets there) waits while a partner in its campaign is mining, instead of pausing with "no route".
- Tests: the split itself (branch shares cover the mine exactly once; grid bands; extra turtles skipped); a branch mine shared by two turtles where the corridor digger is slow (the other waits twice and digs its branches; without the waiting it pauses with "no route"); a grid mine shared by two turtles. Browser check: three turtles on a 32-long branch mine → corridor + 7, 7 and 6 branches. Not yet tried in-game: checklist steps 47-48.


## Faster ore search for big maps (2026-10-23)

- With Geo scanning the map grows by up to ~36 000 cells per scan. The Ores tab's search read every cell of the world (no index can serve `block LIKE '%ore%'`): ~200 ms per 2 million cells, during which the server (SQLite is synchronous) answers nobody.
- Migration 5 adds a partial index holding only possible ore rows; the search uses it (`INDEXED BY`, same condition text from one constant). 2 million cells: ~200 ms → ~17 ms; inserts barely affected. On a copy of the real database (115 000 cells): migration 21 ms, same results, ~7 ms → under 0.5 ms.


## Milestone 6, part A — Geo Scanner mapping (2026-10-23)

- A turtle with an Advanced Peripherals Geo Scanner maps every block within 8 blocks (up to 16, which costs a little fuel) in one scan, and the air between them. AP's scan walks the full cube, leaves out air and reports positions relative to the scanner (read from AP 0.7.7.1r's code, so the in-game probe wasn't needed to start; the agent also copes with absolute positions).
- New agent op `geoScan {radius}` (agent 0.3.3): blocks are sent as observations flagged with the scan and accepted within the radius; then the server marks every cell of the cube the scan didn't report as air, only if all its blocks were recorded. Turtles are never mapped.
- Jobs: **Geo scan as it goes** (every N slices, radius 8–16), waiting out the 2 s cooldown once; scanned ores feed vein following and the Ores tab. A turtle without a scanner logs it once and mines on.
- Dashboard: **Geo scan** in the command bar, right-click a turtle → radius 8 / 16, details show **Geo Scanner** (and **Chunk Controller**) by name, scans counted on the job card. Simulator: `--geo`.
- Tests: Lua agent scan (blocks several cells away, an air pocket, ores found, turtle not mapped, cooldown, no scanner); server (scan radius acceptance, no air marked from a scan that lost a batch); jobs (a vein running off the tunnel wall is mined with scanning and left without it; no scanner = one warning). Browser check: one radius-8 scan made 4 913 cells known and found 10 ores. Not yet tried in-game: checklist steps 37/37b.


## A finished turtle no longer gets stuck on the dock (2026-10-23)

- Seen while making the screenshots: a turtle finished its job, unloaded, and stayed on the dock ("could not move off the dock"), so the next turtle paused with "nothing is driving it". It couldn't reach a waiting spot or where its job started: an idle turtle (which counts as a wall) stood on the only known way.
- Now, when none of those can be reached, it steps off the dock onto the nearest free cell that isn't on the way in (its own or another turtle's coming to the dock), so the next turtle can unload.
- Also: a turtle waiting for the dock now tells traffic control whom it waits for and which way it will come in. If the dock's holder has to get past it to leave, that's a standoff the existing rules resolve (one of them steps aside), and the one stepping aside keeps off the other's way in.
- Test: a 1-wide corridor with a dead end, a turtle left idle in it after the other has passed; the finishing turtle ends up on the free cell above the dock and the dock is free. Fails on the previous code.


## New screenshots (2026-10-23)

- All five README screenshots retaken with the current dashboard (CC Orchestra name, instances, torches), from a simulator scene: two quarries split between three turtles (wall scanning, ore veins, torches), two prospecting tunnels, and a shaft down to a branch mine at Y 12 for the rarer ores. Taken with headless Chrome over the DevTools protocol.
- Small fixes found while doing it: the logo read "CCORCHESTRA" (now a gap between CC and ORCHESTRA); torches were drawn as full blocks in 3D (now a thin glowing stick) and in a random colour on the map (now yellow). The simulator's depot fuel chest now also holds a stack of torches.


## Renamed to CC Orchestra (2026-10-23)

- The project is now **CC Orchestra** (repository https://github.com/v3lip/CC-Orchestra): dashboard title and logo, turtle screen and installer messages, docs, README, log prefix, package and Docker service names.
- Kept on purpose, so existing installs and data keep working: the files on turtles (`/fleet/agent.lua`, `/fleet/state.json`), the database (`data/fleet.sqlite`), the Docker volume (`fleet-data`), browser settings (`ccf.*`) and the internal `@ccfleet/*` package names. The installer recognises launchers installed under the old name, so re-running `install` doesn't back them up as someone else's.


## Torches: steadier in-game (2026-10-22)

- First in-game run (three branch mines plus a 3-wide tunnel, FTB Evolution): 33 torches placed, but 50 attempts failed with "Cannot place block here", one torch fell off later, eMiner1 carried its torches in six slots, and "missed" read 32.
- Causes, from the job log and the map: every failed spot had air under the floor (a cave, or ore veins the turtles dug out below the tunnel), and the runner then retried at every following block. A torch placed first and then undermined by vein following dropped. Each depot visit put the top-up in a new slot. Out of torches, every block counted as a miss.
- Fixes: skip spots whose floor is known to be air; after a failure, wait 3 blocks; inspect what was placed, and if CC hung it on a side block that the job digs later, take it back; vein following never digs a block a torch hangs on; top-ups go into the carried stack; a dark spot counts once per spacing. No agent update needed (uses inspect).
- The simulator now hangs torches on a side block when there's no floor (with facing) and drops torches whose block is dug, like the game. Tests reproduce each case and fail on the previous runner: a cave under the floor, a 3-wide tunnel over a cave, misses counted once, top-ups merged.


## Warning when the backend wasn't restarted after an update (2026-10-22)

- In-game, a torch job stopped with the old "not fuel" error: the backend had been running since the day before, so it was still the pre-torch code (while the rebuilt dashboard already offered the option, which the old backend silently dropped). The backend runs from source and only picks up changes when restarted.
- The backend now fingerprints its code (server + protocol sources, line endings ignored) when it starts and sends it to the dashboard; the dashboard build bakes in the fingerprint it was built against. If they differ, a banner says **Restart the backend** (backend started before the build, or too old to report) or **Rebuild the dashboard** (the other way round). Off in `npm run dev`, where the server restarts on every edit.
- Tests: fingerprint ignores line endings and follows code changes; the init message carries it; the mismatch rules. Browser check: no banner with matching code; after changing a server file and rebuilding only the dashboard, the restart banner with the backend's start time.


## Torches in jobs (2026-10-22)

- New job option **Place torches** (every N blocks, default 10). The turtle puts a torch on the floor cell under the row it walks in, which it digs from above anyway, so torches never block its way; they're excluded from the work area so it never digs them on the way back. In a quarry only the bottom floor gets torches (the floors above are dug away). Tunnels must be at least 2 high; the form says so.
- Torches come from the depot's **fuel chest**: before the job starts (if the turtle has none) and on every trip, up to what the rest of the job needs (max a stack). Unloading keeps them. Since a turtle can only take a chest's first stack, the fuel-chest visit now sets aside whatever it doesn't need right then (extra torches, or coal when fuel is full) and puts it back before leaving. Torches in the fuel chest no longer stop jobs that don't place them with "not fuel".
- New agent op `place {dir, slot}` (agent 0.3.2, Lua and simulated; the simulator places wall or standing torches in CC's order). Jobs with torches ask for 0.3.2. The job card counts torches placed and spots left dark.
- Tests: the Lua agent places, maps and refuses; a tunnel with torches first in the fuel chest (3 torches 8 apart on the floor, the rest given back, coal still reached); torches left alone when the option is off; a quarry lighting only its bottom floor; the same tunnel job with the real Lua agent. Not yet tried in-game: checklist steps 44-46.


## "Movement failed" in claimed chunks (2026-10-21)

- In-game (FTB Evolution, 1.21.1): a turtle couldn't move into a chunk claimed with FTB Chunks; CC only said `Movement failed`, and unclaiming fixed it. CC: Tweaked's own checks (block, fuel, loaded chunk, its protected-area check) pass, then placing the turtle at the new cell is refused: that's the claim's protection against fake players (`fake_players: "check"`, team default "allow fake players" off).
- The dashboard explains that error where it shows (command results, the turtle's last error), and a job that hits it pauses with the cell and the same advice. Setup doc: claims keep turtles out unless the team allows fake players.
- The simulator can claim chunks (`world.claimedChunks`), failing moves into them the same way. Tests: the hint (only for that reason), and a tunnel stopping at the claimed chunk's edge with the advice in the job error.


## Instances: one per world or server (2026-10-21)

- Turtles from another server used to land in the same map, jobs and depots as the old save. Every record already carried a world name; that is now an **instance** you choose: on the login screen (remembered instances plus **＋ New instance…**) or in the header (with live online/total counts). The fleet list, map, jobs and depots show the chosen one; new pairing codes go into it. All turtles stay connected whichever instance is shown; **STOP ALL** still stops every one.
- **Manage instances…** lists each instance's turtles, map blocks, jobs, depots and last contact, and renames (moves turtles, map, depots, jobs and marked chunks; turtles stay connected; refused while a job or go-to runs there) or deletes (unpairs its turtles and removes its data; refused while any of them is online).
- Everything on screen is the chosen instance only: fleet list and counts, map, jobs, depots (also in the job form), command results, activity, and groups (a group holding turtles of several instances shows and selects only this instance's members). Only **STOP ALL** still covers every instance. The store keeps every instance's turtles, jobs and depots (`allTurtles`, …) and exposes the shown instance's as `turtles`, `jobs`, `depots`, reusing the same objects when another instance changes so nothing re-renders.
- Database migration 4 adds an `instances` table so an instance can exist before anything is paired into it. Existing data stays where it was (`main`, `sim`).
- Tests: listing with counts and name validation, rename moving everything with the turtle still online, delete refused while online then removing everything. Browser check on a throwaway backend: login list, switching, live counts, empty-instance message, Manage dialog updating over the socket.


## Milestone 6, B5 — follow camera and 3D shortcuts (2026-10-21)

- **Follow** (3D toolbar, or G): the camera stays on the focused turtle (else the first selected), gliding along at the same viewing angle; the 3D area re-centres when the turtle leaves its middle. Right-drag panning stops following. Remembered in the browser.
- Keys in the 3D view: **X** x-ray, **C** cut above Y, **G** follow, **O** overview, **H** re-centre. They never overlap the turtle-driving keys (W/A/S/D/R/F, Escape) and are ignored while typing; the driving keys now live in the same module (`lib/keys.ts`), with a test that they can't clash.
- Tests: key map (no clash, case-insensitive, ignored while typing), follow smoothing (target and camera move together and settle), when the area re-centres. Browser check on a sim instance: X/C/G/O toggle, typing "xcgo" in the search box toggles nothing, the camera stays on a turtle during a go-to, no console errors.
- That completes Part B of Milestone 6 (3D view upgrades) in the simulator; Part A (Geo Scanner) waits for the in-game probe.


## Milestone 6, B4 — job progress and go-to routes on the maps (2026-10-21)

- 3D: the part of each job section that's dug is drawn filled (faint cyan; grey while paused), the rest as the outline.
- Go-to trips (Control → Go to…, right-click → Send here) now publish their planned route like jobs do; it's drawn in blue, with the target marked, on the 2D map and in 3D.
- Routes are drawn from the turtle onwards: a route is published when it's planned, so the stretch already walked used to stay on the map.
- Tests: route trimming, splitting a section at its progress, progress shared over sections, and the server publishing a go-to's route (ending at the target, cleared on arrival). Browser check on a sim instance: lanes' dug part filled in 3D, a go-to's blue route ahead of the turtle in 2D.


## Milestone 6, B3 — overview inset in the 3D view (2026-10-21)

- A top-down overview in the 3D view's top-right corner: the 3D area (cyan frame), which chunks in it have mapped blocks, job areas, depots, turtles in their status colours (selected ones outlined) and the direction the camera looks. It zooms to fit every turtle and depot, never narrower than 384 blocks. Click it to move the 3D area there; **Overview on/off** in the toolbar hides it (remembered in the browser).
- Its size follows the view (a third of the shorter side, 90–180 px): a fixed 180 px covered most of a small window.
- Tests: framing (minimum range, widening to fit far turtles, chunk-rounded) and click-to-block round trip. Browser check on a sim instance at 1600×1000: inset drawn, a click moved the centre from 1 −9 to 146 −150, hide/show and Re-centre work, no console errors.


## Milestone 6, B2 — level of detail in the 3D view (2026-10-20)

- Chunks within 3 chunks of the centre are drawn in full; farther chunks show each column's top block, water on top, and every ore. At most 200 000 blocks are drawn: past that, near chunks fall back to their surface (nearest keep full detail) and the toolbar says "detail reduced in N chunks".
- Full rebuilds (centre, Y cut, x-ray) run nearest chunk first, ~10 ms per frame, keeping the old meshes until each chunk is replaced: the page stays responsive and the toolbar shows "loading N chunks".
- Fully mapped 256×256×40 (2.6 M cells): near chunks on screen after 0.8 s, everything after 1.8 s spread over frames (was 2.5 s frozen), 104 000 blocks drawn (was 170 000). With the real map a full rebuild is ~15 ms.
- Tests: surface-only classification (top block, ores at any depth, water on top), nearest-first order and the full-detail radius. Browser check on a sim instance: renders, updates live, no console errors.


## Milestone 6, B1 — 3D view in chunks (2026-10-19)

- The 3D view is built from one mesh group per 16×16 chunk column. The map cache keeps a version per chunk; a turtle's map update rebuilds only the chunks it touched (and the neighbour across an edge), not the whole view. The area grew from 80×80 to 256×256.
- Measured with a 256×256 box of the real map (31 000 cells): full rebuild 15 ms, map update 0.2 ms (before: 43 ms on every update). Fully mapped worst case (2.6 M cells): update 8 ms, full rebuild 2.5 s; level of detail (B2) is next.
- Fixed along the way: map requests covering many chunks could pass the server's 100 000-row limit and come back cut short, yet be marked loaded (never refetched). Requests are now tiles of at most 4×4 chunks (≤65 536 cells), and a truncated answer isn't marked loaded.
- Tests: chunk bookkeeping (edge neighbours, tiling under the row limit, one chunk rebuilt per update, reset invalidates). Checked in a browser on a sim instance with 3 turtles quarrying: renders, updates live, no console errors.


## Quality check of milestones 1–5 (2026-10-19)

- A fresh clone installs from the lockfile (0 vulnerabilities), typechecks, builds and passes all tests: everything needed is in git.
- No TODOs, debug output or disabled tests left; no unused dependencies.
- End-to-end run against a throwaway backend with 3 simulated turtles through the real API, 23 checks: login required, dashboard served, groups (M1); manual command, telemetry, pause holds / resume releases (M2); tunnel job with pause and resume, trip home and unloading, exact cell count (M3); campaign in lanes, go-to (M4); branch, quarry and grid jobs with exact cell counts, wall scanning, ore search (M5); no errors or obstructed-move warnings in the log.
- **Bug found and fixed:** a turtle that finished its job stayed on the dock when no other job used the depot at that moment; a job started later by another turtle then failed with "No known safe route … to the dock". A finished turtle now always leaves the dock (a free waiting spot, else where its job started), and a turtle nothing drives standing on the dock gives a clear `dock_blocked` error naming it. Two tests (the first fails on the old code).
- Docs brought in line with what is confirmed in-game; outdated button names in the checklist fixed.


## More fixes: timeouts, busy turtles, history growth, login (2026-10-19)

- **A result that never comes from a connected turtle** paused the job with "turtle went offline". It now says the turtle didn't answer in time (and is still connected), so it isn't mistaken for a chunk or link problem.
- **"busy" after resuming:** right after such a timeout the turtle may still be finishing that command, and resuming failed the job with "another command is running". The mover now waits for a busy turtle (up to 20 s) instead of failing.
- **History grew without limit:** every atomic turtle action is a command row (~90 000 a day while mining; the real database had 73 000 after under a day). Commands and command batches older than 2 days are now deleted at start-up and hourly; the activity log keeps its newest 20 000 entries. Nothing reads older rows.
- **`/api/events?limit=`** passed any number to SQL; `-1` returned the whole log. Now validated (1–1000).
- **Dashboard after a session ends:** the live connection was refused and retried forever while the page showed "down". It now shows the login screen, and a logout stops the reconnect timer that was already scheduled.
- Tests: 4 new (timeout reason and resume past "busy", dashboard socket needs a login, events limit, pruning); the ones about changed behaviour fail on the old code. Checked in a browser: an ended session leads to the login screen.


## Right-click menu on the map (2026-10-19)

- **Right-click** (without dragging; right-drag still pans) on the 2D map or in the 3D view opens a menu:
  - On a turtle: select only it / add or remove from selection, Details, Jobs, Pause, Resume, Cancel queued commands, Emergency stop.
  - On a place: **Send <turtle> here** for the selected turtles (up to 4; uses Go to: known space, no digging, giving way to others), **New job starting here…** (opens the job form with "Enter coordinates" filled in, and the right-clicked turtle chosen if nothing is selected), Copy coordinates, Mark/unmark the chunk as force-loaded, Show in 3D / Show in 2D.
  - 2D: the place is the cell at the current Y; if it is rock, "send here" goes to the open cell on top of it. 3D: the block under the mouse; "send here" goes to the open cell on the side that was clicked.
- Fixed along the way: on the 2D map, zoomed out, the turtle icon is bigger than its block but only the block counted as the turtle, so a visible turtle couldn't be clicked. The click area now covers the icon.
- Checked in a browser on a simulator instance: both menus in 2D and 3D, sending a turtle (it moved there), New job here (form filled in), face-based target in 3D, Escape closes, no console errors.


## Bug fixes after the 3D work (2026-10-19)

- **Gravel:** after digging, the turtle now checks the cell again before moving. Before, it walked into gravel that had already fallen back in (the agent had reported it), the move failed ("Movement obstructed", shown as the turtle's last error), and it recovered by digging again. Expected recovery, but one wasted move per gravel block. A dig that finds nothing now looks at the cell, so a stale "solid" on the map can't make it dig in circles. In-game, falling gravel is an entity for a moment, so a failed move can still happen there; the retry handles it.
- **Fuel reserve:** topping up at the depot burned the whole fuel slot, including the reserve the turtle carries there, and overshot the refuel target. It now burns only what it took from the chest.
- **Cell counts:** cells were counted again after a pause or resume when the turtle walked back through the dug tunnel. Counted cells of unfinished slices are now kept in the job checkpoint.
- **Dock lock:** a turtle paused (or dropped offline) on its way to the dock kept the dock, so every other turtle waited forever. A stopped turtle that isn't on the dock now gives it up (same for waiting spots); resumed, it queues again.
- **3D view:** blocks on the edge of the drawn area counted neighbours outside it, so the sides of a well-mapped area showed holes (50 of 98 blocks drawn in the test). Rebuilds on map updates are throttled to twice a second (updates arrive every 100 ms; a fully mapped area took ~150 ms per rebuild), and block colours are parsed once.
- Tests: 7 new (gravel without failed moves, reserve kept, cells counted once, paused dock holder, 4 for 3D visibility); each fails on the old code. Simulator: the 3-turtle quarry that showed the warning now has none, with exact cell counts; 3D view checked in a browser (render, hover, click to select, no console errors).


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

- **Mark force-loaded chunks** on the map (**▦ Chunks → Mark force-loaded…**, click to toggle). Stored in SQLite (migration 3) and shared live. CC Orchestra can't detect FTB Chunks' force-loads itself.
- **Chunks a job uses:** the estimate returns the tunnel footprint, the dock, and the chunks on the line between them, with marked/unmarked status. The form outlines unmarked ones (informational, no warning).
- **Crossing note:** if a job's turtle disconnects right at a chunk border, the pause reason says *went offline as it crossed from chunk A into chunk B*. Routes now include the start cell so "just crossed" is recognised.
- Docs: why the Controller isn't enough, FTB Chunks setup, and the Esc/alt-tab pause gotcha (F3+P).
- Tests: 58 (estimate chunk coverage and marking; diagnosis when the link drops at a border).

## Milestone 4 — multi-turtle scheduling, traffic, depot queues ✅ (2026-10-18; confirmed in-game)

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

## Milestone 3 — tunnel job, automatic return, verified unloading, resume ✅ (2026-10-18; confirmed in-game)

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

## Milestone 2 — Lua agent, pairing, telemetry, calibration, manual control ✅ (2026-10-18; confirmed in-game)

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
