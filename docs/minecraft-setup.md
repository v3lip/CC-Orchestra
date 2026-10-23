# Minecraft / CC: Tweaked setup

Detected in your instance (FTB Ultimate Anniversary Edition 1.3.1):

| | |
|---|---|
| Minecraft | 1.16.5 |
| Mod loader | Forge 36.2.26 |
| CC: Tweaked | 1.100.2 (`cc-tweaked-1.16.5-1.100.2.jar`) |
| Relevant extras | Advanced Peripherals 0.7.7.1r, FTB Chunks, Create, Refined Storage |
| World config | `saves/__Main__/serverconfig/computercraft-server.toml` |

## 1. Let turtles reach the backend (required)

Your world config currently has:

```toml
[[http.rules]]
    host = "$private"
    action = "deny"
```

That blocks `127.0.0.1` and every LAN address, so turtles **cannot** connect to a backend on your PC. Do not delete this rule. Instead, add one narrow allow rule **above** it, for exactly the backend's address and port. Port-specific rules exist since CC: Tweaked 1.93.0.

```toml
# CC Orchestra backend: only this address and port.
[[http.rules]]
    host = "127.0.0.1"
    port = 8787
    action = "allow"

[[http.rules]]
    host = "$private"
    action = "deny"

[[http.rules]]
    host = "*"
    action = "allow"
    # ...existing limits unchanged...
```

- Rules are checked from the top, so the allow must come **before** the `$private` deny. The installer checks this by calling `http.checkURL` and prints a clear error if it is blocked.
- If the backend runs on another machine, use its LAN IP (e.g. `192.168.1.50`) instead of `127.0.0.1`, and set `PUBLIC_URL` in `.env` to match.
- Edit the file with Minecraft closed (or restart the world afterwards).
- WebSockets are already enabled in your config (`websocket_enabled = true`, `max_websockets = 4` per computer; the agent uses one).

## 2. Install the agent on a turtle

Use a **mining turtle** (crafted with a diamond pickaxe). Then:

1. Dashboard → **Add turtle** → choose world/dimension → **Create pairing code** (single use, 15 minutes).
2. On the turtle:
   ```
   wget http://127.0.0.1:8787/turtle/install.lua install.lua
   install ABCD-EFGH
   ```
3. Answer the calibration prompt with the turtle's block coordinates (F3) and the direction its front faces, e.g. `120 64 -35 n`. Or press Enter and calibrate from the dashboard.

The installer checks the http rule first (`http.checkURL`) and explains if it is blocked. It keeps an existing `startup.lua` as `startup.lua.bak`, writes `/fleet/agent.lua`, `/startup.lua` and `/fleet/config.json`, and labels the turtle so it keeps its files when picked up.

- **Update** the agent later: run `install` again with no code. Identity and position are kept.
- **Re-pair** (e.g. after removing it in the dashboard): `install <NEW-CODE>`.
- Files on the turtle: `/fleet/state.json` (credentials, position, movement journal, recent commands, hold). Don't edit it while the agent runs.
- **Ctrl+T** stops the agent; `startup` starts it again. If the agent crashes, `startup.lua` restarts it after 5 s.

## 3. Fuel

`need_fuel = true` in your config: turtles hold up to 20,000 fuel (100,000 for advanced turtles). Coal and charcoal give 80 each. Movement costs 1 fuel per block; turning, digging and inspecting cost nothing.

### Depot (for jobs)

A depot is one **dock cell** where a turtle parks, plus chests next to it:

```
 side view, dock facing west            top view
                                          N
   [ air  ]   ← keep clear                ↑
 [C][TURTLE]  ← dock cell            [C][D]→ tunnel
   [ F ]      ← optional fuel chest
```

- **Unload chest** (`C`): in front of, above, or below the dock. A double chest is fine. Turtles only drop items when that block is an inventory. If it's missing, the job pauses with "No chest…" and nothing is spilled.
- **Fuel chest** (`F`, optional): on a different side. Keep **fuel** in it (coal, charcoal, coal blocks), and **torches** if your jobs place them. It does not refill itself: you or a farm/hopper must keep it stocked. A turtle can only take the chest's first stack, so it sets aside whatever it doesn't need right then and puts it back before leaving. Anything that's neither fuel nor a torch is put back and the job pauses.
- **Torches** (job option *Place torches*): the turtle takes what the job needs from the fuel chest (up to a stack) before it starts and on every trip, and never unloads them. It puts them on the floor under its walking row, so tunnels need to be at least 2 high; in a quarry only the bottom floor gets them.
- **Fuel slot** (default slot 16): fuel the turtle carries. It's kept when unloading and only burned when the turtle would otherwise run short.
- Set it up in the dashboard: park a turtle on the dock facing the way you want, select it → **Depots** → **New depot** → "Use … as the dock", then choose where the chests are.
- Keep the dock and the route between the dock and the tunnel open (air). Jobs only dig inside their own tunnel volume, never on the way there.

Fuel also matters for reliability: after a crash mid-move, the agent uses the fuel level to tell whether the move happened (see `docs/protocol.md`). With unlimited fuel that evidence does not exist, and an interrupted move needs manual reconciliation.

## 4. Chunk loading — read this

Turtles are not chunk loaders. If no player is near a turtle, its chunk unloads and the turtle **freezes mid-program**. From the backend's view it goes stale and then offline, and its in-flight command becomes `unknown` until it is loaded again.

Options in your pack:

- **Chunky turtles (recommended for jobs):** an Advanced Peripherals **Chunk Controller** on one side of the turtle (the other side keeps the pickaxe). Craft it into a turtle, or equip it on a free side. Details below.
- **FTB Chunks** (installed): claim and force-load the mining area's chunks. This is per-team; check the force-load limits in its config. CC Orchestra can't see these.
  - **Claims keep turtles out.** A turtle counts as a *fake player*, and with FTB Chunks' defaults it can't enter or work in a claimed chunk: moves fail with CC's vague **`Movement failed`** (not "obstructed"), and a job pauses there. The dashboard now says so next to that error. Fix it in-game: open the FTB Chunks map → team settings and allow **fake players** for your team (claimed chunks stay protected from other players), or don't claim chunks the turtles work in. On a private world you can instead set `disable_protection: true` in `ftbchunks-world.snbt`, keeping claims for force-loading only.
- **Stay nearby.**

### Chunky turtles (Advanced Peripherals 0.7.7.1r)

Checked against the installed jar and your config, not just the wiki:

- The upgrade shows up as a peripheral of type `chunky` on its side. The agent reports it, and the dashboard shows a **CHUNK** badge, the upgrade in the details panel, and green "kept loaded" chunks on the map (**▦ Chunks** toggle).
- It force-loads **one chunk: the one the turtle is in**, and moves the load along as the turtle moves.
- **In practice (your world):** chunky turtles have worked 500+ blocks from the player, crossing many chunk borders. **Once** (2026-10-18), a turtle shut down right at a chunk border on a long trip back to the dock, and came back by itself about a minute later. The cause is unknown. To find out if it happens again, set `enableDebugMode = true` in `config/Advancedperipherals/general.toml`: Advanced Peripherals then logs every chunk it force-loads and releases ("Trying to load forced chunk …") in `logs/latest.log`. The backend's activity log now records how the connection closed.
- **Recovering by itself:** tick **"Resume automatically if the turtle reconnects"** in the job's policy, and a job that paused because its turtle dropped will continue when the turtle comes back (within 15 min, at most 3 times an hour, only with a known position and heading).
- **Optional:** for chunks you force-load yourself (FTB Chunks), mark them on the map (**▦ Chunks → Mark force-loaded…**). The job form outlines the chunks a job uses.
- The load is saved with the world and restored when the server starts. It expires if the turtle stops refreshing it for `chunkLoadValidTime` (**600 s** in `config/advancedperipherals-common.toml`), e.g. when the Controller is removed.
- `enableChunkyTurtle = true` in your config.

**Pausing:** in single-player, the Esc menu pauses the whole world, and so does alt-tabbing unless you turn off pause-on-lost-focus (**F3+P**). After 30 s the turtles count as offline and their jobs pause.

**What it can't do:** in **single-player**, the world only runs while you have it open. Leaving the world or closing Minecraft stops every turtle, chunky or not, and they resume (agent restarts via `startup.lua`) when you load the world again. The chunky turtle lets you go somewhere else in the same world (another base, the Nether…) while turtles keep mining. To mine while you are not playing at all, run the world on a **dedicated server** (the FTB pack has server files) and keep the CC Orchestra backend running.

**Updated agent needed:** run `install` on the turtle (agent `lua-0.3.1`) so it reports its upgrades. Older agents work as before but show no chunk info.

Nothing in CC Orchestra assumes chunks stay loaded. A turtle whose chunk unloads is shown stale/offline, and its last position is still treated as occupied.

## 5. Optional: GPS

`gps.locate()` needs **four or more** GPS host computers with wireless modems, running `gps host x y z`, in range of the turtle. Your modem range is 64 blocks at low altitude and 384 blocks high up. A turtle also needs a wireless modem to use GPS.

GPS gives **position only, never heading**. Without GPS you calibrate each turtle by hand: stand next to it, read its coordinates on the F3 screen, and enter them with the direction its front faces.

## 6. Optional mapping adapters (later milestones)

| Adapter | Requires | Gives |
|---|---|---|
| Baseline (always) | CC: Tweaked only | blocks the turtle inspects or moves into |
| Geo Scanner | Advanced Peripherals geo scanner (exact API for 0.7.7.1r to be verified against its docs before use) | nearby blocks in a radius, with a cooldown |
| Server-side integration | a server mod/plugin with world access | anything; out of scope until requested |
