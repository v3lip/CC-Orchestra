# In-game verification checklist

The automated tests run the real Lua agent in a CC-like host (Lua 5.4 under Node), not in CC: Tweaked itself. Milestone 2 has been confirmed in-game (connected, position tracking, mapping, obstruction). Milestone 3 has not been tested in-game yet.

## Milestone 3: tunnel job, depot, unloading

**Update first.** Restart the backend (`npm start`) so it loads Milestone 3 and migrates the database. Then on each turtle run `install` (no code; it keeps identity and position). The turtle screen should show `lua-0.3.0`. Jobs refuse to start on older agents.

1. [ ] Build a depot next to a rock face (see [minecraft-setup.md](minecraft-setup.md#depot-for-jobs)): a dock cell, a chest in front of / above / below it, and optionally a fuel chest with some coal. Put a few coal in the turtle's slot 16.
2. [ ] **Key check: chest as a peripheral.** Park the turtle on the dock. Press Ctrl+T to stop the agent, then run `lua` and `peripheral.wrap("front").list()` (or `"top"`/`"bottom"` for a chest above or below). It must return a table, not an error or `nil`. If it doesn't, unloading will safely refuse to drop anything; tell me. Afterwards `exit()` and `startup` to restart the agent.
3. [ ] Dashboard → **Depots** → **New depot** → "Use … as the dock" → set the facing/chest sides → Save. The dock (cyan) and chest (`C`/`F`) markers appear on the map.
4. [ ] Drive the turtle to the tunnel mouth facing the rock. **Jobs** → **New tunnel** → "Start the tunnel in front of the turtle" → 1×2×16 → check the dashed preview on the map → **Create & start**.
5. [ ] The job runs: status *running*, phases mining → returning → unloading. The turtle digs only inside the outline. The map fills in the tunnel.
6. [ ] When done, it returns to the dock, faces the chest, and unloads everything except coal in slot 16. Compare the chest contents with "items unloaded" on the job card.
7. [ ] **Mid-job return:** start a longer tunnel (1×2×64) with "Return when free slots ≤" set to 13. It goes home partway, unloads, walks back to where it stopped, and continues.
8. [ ] **Manual takeover:** while it's mining, press W. The job shows *paused: manual control took over* after the current block. **Resume** continues the tunnel.
9. [ ] **E-STOP during a job:** it stops after the current action; the job pauses. Resume the turtle (Control → Resume), then resume the job.
10. [ ] **Missing chest:** break the depot chest and start a short job. At unload time the job pauses with "No chest … nothing was dropped". **No items on the ground.** Replace the chest and resume.
11. [ ] **Protected block:** place a chest inside a planned tunnel's outline. The job pauses with a "Protected block" error and the chest is intact.
12. [ ] **Gravel:** tunnel through gravel or sand. Falling blocks are re-dug, and the tunnel ends up clear.
13. [ ] **Chunk unload:** walk away mid-job. The turtle goes offline, the job pauses (*turtle went offline*), and the dashboard keeps its last position. Come back, then resume the job.

14. [ ] **Several turtles, one depot:** put 2–3 turtles side by side at a rock face, 2+ blocks apart, facing the rock. Select them all → **Jobs** → **New tunnel**. Each gets its own tunnel in front of it (check the preview), then **Create & start N jobs**. When two want to unload at once, one shows *waiting for the dock (in use by …)* until the other is back in its tunnel.

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
