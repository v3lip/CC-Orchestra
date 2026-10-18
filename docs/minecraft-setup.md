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
# CC Fleet backend: only this address and port.
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

Fuel also matters for reliability: after a crash mid-move, the agent uses the fuel level to tell whether the move happened (see `docs/protocol.md`). With unlimited fuel that evidence does not exist, and an interrupted move needs manual reconciliation.

## 4. Chunk loading — read this

Turtles are not chunk loaders. If no player is near a turtle, its chunk unloads and the turtle **freezes mid-program**. From the backend's view it goes stale and then offline, and its in-flight command becomes `unknown` until it is loaded again.

Options in your pack:

- **Stay nearby** (simplest).
- **FTB Chunks** (installed): claim and force-load the mining area's chunks. This is per-team; check the FTB Chunks force-load limits in its config.
- **Advanced Peripherals' Chunky Turtle** (0.7.7.1r installed): a turtle upgrade that keeps the turtle's own chunk loaded while it moves. It is an optional adapter for later milestones and needs nothing from the baseline.

Nothing in CC Fleet assumes chunks stay loaded. A turtle whose chunk unloads is shown stale/offline, and its last position is still treated as occupied.

## 5. Optional: GPS

`gps.locate()` needs **four or more** GPS host computers with wireless modems, running `gps host x y z`, in range of the turtle. Your modem range is 64 blocks at low altitude and 384 blocks high up. A turtle also needs a wireless modem to use GPS.

GPS gives **position only, never heading**. Without GPS you calibrate each turtle by hand: stand next to it, read its coordinates on the F3 screen, and enter them with the direction its front faces.

## 6. Optional mapping adapters (later milestones)

| Adapter | Requires | Gives |
|---|---|---|
| Baseline (always) | CC: Tweaked only | blocks the turtle inspects or moves into |
| Geo Scanner | Advanced Peripherals geo scanner (exact API for 0.7.7.1r to be verified against its docs before use) | nearby blocks in a radius, with a cooldown |
| Server-side integration | a server mod/plugin with world access | anything; out of scope until requested |
