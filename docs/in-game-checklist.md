# In-game verification checklist (Milestone 2)

None of this has been checked inside Minecraft yet. The automated tests run the real Lua agent in a CC-like host (Lua 5.4 under Node), not in CC: Tweaked itself. Work through this list once in your world and note anything that differs.

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
