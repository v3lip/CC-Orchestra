# In-game verification checklist

The automated tests run the real Lua agent in a CC-like host (Lua 5.4 under Node), not in CC: Tweaked itself. Milestone 2 has been confirmed in-game (connected, position tracking, mapping, obstruction). Milestone 3 has not been tested in-game yet.

## Milestone 3: tunnel job, depot, unloading

*Confirmed in-game by the user (2026-10-18): tunnel jobs with automatic return and unloading. The individual items below weren't each reported.*

**Update first.** Restart the backend (`npm start`) so it loads Milestone 3 and migrates the database. Then on each turtle run `install` (no code; it keeps identity and position). The turtle screen should show `lua-0.3.0`. Jobs refuse to start on older agents.

1. [ ] Build a depot next to a rock face (see [minecraft-setup.md](minecraft-setup.md#depot-for-jobs)): a dock cell, a chest in front of / above / below it, and optionally a fuel chest with some coal. Put a few coal in the turtle's slot 16.
2. [ ] **Key check: chest as a peripheral.** Park the turtle on the dock. Press Ctrl+T to stop the agent, then run `lua` and `peripheral.wrap("front").list()` (or `"top"`/`"bottom"` for a chest above or below). It must return a table, not an error or `nil`. If it doesn't, unloading will safely refuse to drop anything; tell me. Afterwards `exit()` and `startup` to restart the agent.
3. [ ] Dashboard → **Depots** → **New depot** → "Use … as the dock" → set the facing/chest sides → Save. The dock (cyan) and chest (`C`/`F`) markers appear on the map.
4. [ ] Drive the turtle to the tunnel mouth facing the rock. **Jobs** → **+ New job** → **Tunnel** → "Start in front of the turtle" → 1×2×16 → check the dashed preview on the map → **Create & start**.
5. [ ] The job runs: status *running*, phases mining → returning → unloading. The turtle digs only inside the outline. The map fills in the tunnel.
6. [ ] When done, it returns to the dock, faces the chest, and unloads everything except coal in slot 16. Compare the chest contents with "items unloaded" on the job card. Then it moves off the dock (to a free waiting spot, else back to where the job started), so the next job can use the dock.
7. [ ] **Mid-job return:** start a longer tunnel (1×2×64) with "Return when free slots ≤" set to 13. It goes home partway, unloads, walks back to where it stopped, and continues.
8. [ ] **Manual takeover:** while it's mining, press W. The job shows *paused: manual control took over* after the current block. **Resume** continues the tunnel.
9. [ ] **E-STOP during a job:** it stops after the current action; the job pauses. Resume the turtle (Control → Resume), then resume the job.
10. [ ] **Missing chest:** break the depot chest and start a short job. At unload time the job pauses with "No chest … nothing was dropped". **No items on the ground.** Replace the chest and resume.
11. [ ] **Protected block:** place a chest inside a planned tunnel's outline. The job pauses with a "Protected block" error and the chest is intact.
12. [ ] **Gravel:** tunnel through gravel or sand. Falling blocks are re-dug, and the tunnel ends up clear.
13. [ ] **Chunk unload:** walk away mid-job. The turtle goes offline, the job pauses (*turtle went offline*), and the dashboard keeps its last position. Come back, then resume the job.

14. [ ] **Several turtles, one depot:** put 2–3 turtles side by side at a rock face, 2+ blocks apart, facing the rock. Select them all → **Jobs** → **+ New job** → **Tunnel** → **One each**. Each gets its own tunnel in front of it (check the preview), then **Create & start N jobs**. When two want to unload at once, one shows *waiting for the dock (in use by …)* until the other is back in its tunnel.

### Milestone 4: traffic, lanes, waiting spots, group controls

*20–32 reported working in-game by the user (2026-10-18). Turtles meeting head-on bumped at first; fixed by giving way early (30).*

20. [x] **Waiting spots:** Depots → Edit → drive a turtle to an open cell near the dock (off the main path) → "+ position" → Save. Repeat for a second spot. They show as dashed **W** squares on the map.
21. [x] **Shared tunnel:** line up 2–3 turtles side by side facing the rock. Select them → Jobs → + New job → Tunnel → **Share one**, width ≥ number of turtles. The preview shows one lane in front of each turtle. **Create & start**. A campaign card appears with combined progress.
22. [x] When two turtles need the dock at once, one goes to a waiting spot (job note: *waiting for the dock … at …*) and docks when the other has left. **Without waiting spots** it should still come back and wait a few blocks from the dock, out of the other turtle's way, not at the end of its tunnel.
23. [x] **Pause all / Resume all** on the campaign card. Also select two of the turtles: the "Jobs of N selected turtles" bar pauses/resumes just those.
24. [x] **Go to:** select one turtle, Control → **Go to…**, enter a nearby coordinate in known space. It drives there without digging. Pressing W during the trip stops it.
25. [x] **Head-on:** send two turtles towards each other through a 1-wide passage with a side alcove they have both seen (walked past or inspected). One steps into the alcove (activity log: *steps aside*), and both arrive. With no alcove, a *block each other* error appears within ~30 s instead of them pushing forever.

### Milestone 5: branch mine, quarry, ore scanning

26. [x] **Branch mine:** Jobs → + New job → **Branch**, length 24, spacing 4, branch length 6, both sides. The map preview shows the corridor and branches. Run it: branches are 1 wide, with stone left between them.
27. [x] **Quarry:** New job → **Quarry** 5×5, 6 deep, in front of the turtle (on flat ground). It clears top down and goes back to unload when full.
28. [x] **Scan the walls:** tick it on a short tunnel. Afterwards the map, at the tunnel's level and one above, shows the walls on both sides as observed blocks (not unknown).
29. [x] **Follow veins:** tick **Diamond** (or **Any ore** for a quick test) plus Scan the walls, and tunnel at diamond level (Y 5–12 on 1.16). When it sees a matching ore beside the tunnel, the job note says *following a vein of …*; it mines just the ore blocks and returns to the tunnel. The job card shows ◆ finds, and **◆ Ores** on the map marks ores it has seen but not mined.

30. [x] **Head-on:** send two turtles towards each other through a 2-high tunnel (e.g. one returning to the depot, one going back to work). The one that started later switches row a few blocks before they meet (activity log: *takes a parallel path to pass …*); neither bumps into the other.
31. [x] **Grid mine:** New job → **Grid**, width 16, length 32, tunnel every 3, with Scan the walls. Tunnels are dug every 3 blocks, joined at alternate ends.
32. [x] **Ores tab:** after a job with wall scanning, open **Ores**: ores seen but not mined are listed by type and vein, nearest first. Clicking one centres the map on it at its Y level.

### Milestone 6: 3D view

33. [ ] Click **3D** (bottom right of the map). Tunnels, walls the turtles scanned and the turtles themselves appear in 3D around the focused turtle; drag to orbit, right-drag to pan, wheel to zoom.
34. [ ] **X-ray on:** ordinary blocks fade, ores stay bright. **Cut above Y:** move the Y slider to a tunnel's level to look down into it.
35. [ ] Click a turtle in 3D: it becomes selected (fleet list and details panel follow). Hover a block: its name and coordinates show.

36. [ ] **Right-click menu:** select a turtle, right-click an open spot on the map (2D or 3D) → **Send … here**: it drives there through known space. Right-click a turtle: Pause / Resume / Details work. **New job starting here…** opens the job form with those coordinates.

37. [ ] **Geo Scanner (agent 0.3.3: run `install` on the turtle):** equip an Advanced Peripherals Geo Scanner on a free side of a calibrated turtle. Its details say **Geo Scanner** under Upgrades. Select it → **Geo scan** (command bar): the map fills in around it (blocks and the air between them, 8 blocks each way, also in 3D) and nearby ores show up in the Ores tab. Right-click it → **Geo scan, radius 16**: a bigger area, a little fuel. Report if blocks land in the wrong place (offset or mirrored): positions are taken as relative to the turtle, which is how AP 0.7.7 does it.
37b. [ ] New job with **Geo scan as it goes** (every 8, radius 8) and vein following on: the job card counts scans, and veins a few blocks into the walls get mined.

38. [ ] **3D overview:** in 3D, the inset at the top right shows the 3D area (cyan), your turtles and the depot. Click somewhere in it: the 3D area moves there. **Re-centre** goes back.

39. [ ] **Progress and routes:** while a job runs, the dug part of its area is filled in 3D. Send a turtle somewhere (right-click → Send … here): a blue route runs ahead of it to a marked target, in 2D and 3D, and disappears when it arrives.

40. [ ] **Follow and keys:** select a turtle that's working, open 3D, press **G**: the camera stays on it as it moves. Right-drag stops following. **X**, **C**, **O**, **H** toggle x-ray, cut, overview and re-centre; typing in a text field doesn't trigger them.

### Sharing branch and grid mines

47. [ ] **Shared branch mine:** line up 2–3 turtles at the start, the first one facing the rock. Select them → Jobs → + New job → Branch → **Share one**. The list shows "corridor + N branches" for the turtle in front and "N branches" for the others. **Create & start**: the first digs the corridor; the others wait ("waiting for … to open the way") and dig their branches as the corridor reaches them.
48. [ ] **Shared grid mine:** line up turtles side by side facing the rock → Grid → **Share one**: each gets a band of tunnels in front of it; all finish and the whole grid is dug.

### Job queues

49. [ ] Give a working turtle a second and third job: select it → Jobs → + New job → tick **Queue after the current job** → Create & start (twice). The fleet list shows **+2** next to it, its details a **Queue** row ("2 jobs · next: …"), the cards "1st/2nd in …'s queue", and on the map the queued areas are violet and dashed (running cyan, waiting grey; also in 3D). **↑ / ↓ / Run next** reorder them. When the first job completes, the next one starts by itself.

### Minimap waypoints

50. [ ] Right-click the map → **Copy as JourneyMap waypoint** (or **Copy as Xaero's waypoint**, whichever minimap your pack has). In Minecraft, open chat, paste (Ctrl+V) and send: the message should be a clickable waypoint; click it to add it. Same with **JourneyMap** / **Xaero** on a depot card. Report the exact text if the mod doesn't pick it up (the format differs between mod versions).

### Instances (several worlds or servers)

41. [ ] Log out. The login screen has an **Instance** list; your current world shows there (existing data is in `main` unless you named it otherwise). Choose **＋ New instance…**, name it after the other server or save, and log in: the fleet list is empty and says how many turtles are in other instances.
42. [ ] **+ Add turtle** in that instance and run `install <code>` on a turtle in the other world: it appears there only, and its map starts empty. Switch back with the header list: your old turtles and map are untouched (and still online if that world is running).
43. [ ] Header list → **Manage instances…**: counts are right. Rename the new instance: its turtle stays connected. Deleting an instance with online turtles is refused.

### Torches (agent 0.3.2: run `install` on each turtle first)

44. [ ] Put a stack of torches **and** some coal in the depot's fuel chest (torches in the first slot). New job → Tunnel, 2 high, 32 long → **Place torches** every 10 → Create & start. The turtle goes to the depot first, takes a few torches, and puts the rest back.
45. [ ] In the tunnel: torches stand on the floor every ~10 blocks, under the row the turtle walks in, and the turtle never digs them on its way back. The job card counts them. Report if any torch ends up on a wall or ceiling, or isn't placed (the job log says why).
46. [ ] With **Place torches** off, torches in the fuel chest are left alone (the job doesn't pause with "not fuel").

### Chunky turtles (Chunk Controller)

15. [ ] Equip a Chunk Controller on a turtle's free side (or craft a Chunky Turtle), then run `install` on it (agent `lua-0.3.1`). The dashboard shows **CHUNK** in the fleet list, and the details panel shows `chunky` on that side.
16. [ ] Map **▦ Chunks on**: the turtle's chunk is green "kept loaded". Non-chunky online turtles show a dashed blue "loaded now" chunk.
17. [x] Crossing chunk borders far from the player works (confirmed: 500+ blocks away). One unexplained drop at a border on a long return trip was seen once (2026-10-18).
18. [ ] **Auto-resume:** create a job with "Resume automatically if the turtle reconnects" ticked. If a turtle drops and comes back within 15 minutes, the job continues by itself (activity log: *resumed automatically*). If it happens again, note the close code in the activity log's *disconnected* line, and the AP debug lines if you enabled them (see minecraft-setup.md).
19. [ ] Save & quit, then reload the world: turtles reconnect by themselves (their chunks are restored by Advanced Peripherals). Jobs show *paused (turtle went offline)*; resume them.

Report: the job card's error box, plus the turtle's screen.

---

# Milestone 2 checklist (confirmed in-game)

## Before you start

- [ ] The http allow rule from [minecraft-setup.md](minecraft-setup.md#1-let-turtles-reach-the-backend-required) is added **above** the `$private` deny, and the world was restarted.
- [ ] The backend is running (`npm run start`), and the dashboard at http://127.0.0.1:8787 logs in.
- [ ] You have a **mining turtle** (crafted with a diamond pickaxe), fuelled with a few coal (`refuel` in its shell, or use the dashboard later).
- [ ] Optional, for GPS: a wireless modem on the turtle's other side and 4 GPS hosts in range.

## Pairing and telemetry

1. [ ] Dashboard → **Add turtle**, keep world `main` / Overworld → **Create pairing code**.
2. [ ] On the turtle: `wget http://127.0.0.1:8787/turtle/install.lua install.lua`
   - If wget says the domain is not permitted, the http rule is wrong or the world wasn't restarted.
3. [ ] `install <CODE>`. Expect "Downloading /fleet/agent.lua", then "Downloading /startup.lua", then the calibration prompt.
4. [ ] Press F3, look at the turtle, and enter its block X Y Z and the direction its **front** faces, e.g. `120 64 -35 n`.
5. [ ] The turtle screen shows `Link: online`, its position, and its fuel. The dashboard shows it **online**, not marked SIM, at those coordinates, with the right inventory. The turtle got a label (shown in the details panel).
6. [ ] Break the turtle and place it back **in the same spot, facing the same way** (labelled turtles keep their files). It reconnects within a few seconds with the same identity and position. If you place it somewhere else, the agent cannot know: recalibrate it.

## Manual control

7. [ ] Select it, press **W**: it moves one block, the dashboard position changes by exactly one block in the facing direction, and fuel drops by 1.
8. [ ] **A/D** turn it; the heading arrow on the map matches the in-game facing.
9. [ ] Put a block in front, press **W**: the result is `failed [obstructed] Movement obstructed`, and the position is unchanged.
10. [ ] **Dig → Front**: the block is mined and appears in the inventory grid.
11. [ ] Move into a cave or tunnel: blocks it inspects show on the map at the turtle's Y level. Unknown cells stay hatched.
12. [ ] Calibrate with a deliberately wrong heading, press W, and check that the dashboard position is wrong in a predictable way. Then recalibrate correctly. (This confirms there is no hidden heading magic.)

## Safety

13. [ ] Queue several moves (press W ~5 times quickly), then **E-STOP**. It stops after the current block; the rest show `cancelled`; the results row says `stopped`.
14. [ ] While stopped, W is refused with `rejected [held]`. Reboot the turtle (Ctrl+R): it comes back still held. **Resume**, and W works again.
15. [ ] Stop the backend while the turtle is idle. The turtle screen shows offline/reconnecting and the turtle does nothing. Start the backend: it reconnects by itself (backoff up to 30 s).
16. [ ] Hold Ctrl+R **during** a move a few times. After it reconnects the position is still correct (`position known`). If the dashboard ever shows **uncertain**, it lists both candidate cells; fix it with GPS or calibrate.
17. [ ] Walk far away so the turtle's chunk unloads. The dashboard shows it **stale**, then **offline**, keeps its last position as a dashed marker, and never claims it received anything sent meanwhile.

## Optional: GPS

18. [ ] With a modem and GPS hosts: **GPS fix** returns the coordinates, and `agreedWithTracking` is true if the tracking was right. The heading is unchanged.
19. [ ] Without a modem: **GPS fix** fails with `[no_gps] no modem attached`.

Report anything unexpected along with the turtle's screen and the dashboard's results row; those two together pin down most problems.
