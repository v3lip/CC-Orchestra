# Wire protocol v1

Source of truth: [`packages/protocol/src/index.ts`](../packages/protocol/src/index.ts). The Lua implementation is [`turtle/fleet/agent.lua`](../turtle/fleet/agent.lua); the TypeScript simulator agent is `apps/sim/src/turtle.ts`.

## Transport

- Turtles open an **outbound** WebSocket to `ws://<backend>/ws/turtle`. The backend never connects to a turtle.
- One JSON object per text frame, **≤ 64 KiB** (CC: Tweaked's default limit is 128 KiB per message).
- Every message has `v` (protocol version, `1`), `type`, `id` (unique per sender) and `ts` (sender epoch ms; on CC use `os.epoch("utc")`).
- The Lua agent targets CC: Tweaked **1.100.2** (your install). There, `textutils.serializeJSON(t)` encodes an empty table as `{}`. The server accepts `{}` wherever an array is expected. Turtles never send `null`; an absent field means "unknown".
- Rate limit: 60 messages/second per turtle socket. The first message must be `enroll` or `hello` within 10 s.

## Coordinates

Minecraft axes: X east, Z south, Y up. Heading `0` north (−Z), `1` east (+X), `2` south (+Z), `3` west (−X).
The world and dimension are **assigned by the operator** at pairing time, because a turtle cannot detect them.

## Session

```
turtle                                   server
  │ enroll {code, computerId, agent}  →    (first boot only; one-time code)
  │                                   ←    enrolled {turtleId, secret, name}
  │ hello {turtleId, secret, bootId, recent[]} →
  │                                   ←    welcome {serverTime, heartbeatMs, config}
  │ snapshot {state}                  →    (full state; also sent after every state change)
  │ hb {seq, fuel}  every heartbeatMs →
  │                                   ←    hb_ack {seq}
```

- `secret` is stored hashed (SHA-256) on the server. Credentials are per turtle and revoked by removing the turtle.
- `bootId` is random per boot, so the server can tell a reboot from a reconnect.
- `recent[]` is the agent's **persisted** record of its last 16 command IDs and their status (`running` = started, never finished). The server uses it to resolve commands whose outcome it marked `unknown`.
- Server-side liveness: no message for 12 s → **stale**; for 30 s → the socket is dropped → **offline**. Agent-side: no message for 20 s → close and reconnect with exponential backoff (1 s … 30 s, jittered).

## Commands

```
server → cmd {commandId, op, args, expiresAt, executor}
turtle → ack {commandId, status: accepted | rejected | duplicate, code?, reason?}
turtle → snapshot {state}
turtle → result {commandId, status: succeeded | failed | cancelled, code?, reason?, data?, duplicate?}
```

Rules both sides enforce:

1. **One executor.** The server sends at most one command per turtle and waits for its result before sending the next (per-turtle FIFO queue, max 16). The agent also rejects with `busy` if a command arrives while one runs.
2. **Whitelisted ops only:** `forward back up down turnLeft turnRight dig digUp digDown inspect inspectUp inspectDown select refuel calibrate gpsLocate setLabel drop suck inventoryInfo place`. There is no remote-code operation.
   - `dig*` `{force?}`: the agent refuses (`protected`) to dig any block that is an inventory peripheral (chests, other turtles…), always. It also refuses blocks whose id contains a protected pattern (`welcome.config.protectedBlocks`, e.g. `chest`, `computercraft:`, `spawner`), unless `force` is set.
   - `drop {dir, slot, count?}`: **verified drop** into the inventory `front`/`up`/`down`. It refuses with `no_inventory` unless `peripheral.wrap(side)` is an inventory (checked before *and* right before dropping), because `turtle.drop` with no inventory throws items into the world. The result data is `{item, dropped, requested, partial, chestGain, verified}`; `verified` is false if the chest count didn't rise by `dropped` (e.g. a hopper draining it). Nothing accepted → `inventory_full`.
   - `suck {dir, slot, count?}`: only from an inventory (never item entities). Data: `{taken, slots[]}`.
   - `inventoryInfo {dir}` → `{block, size, used, free, items[]}`, or `no_inventory`.
   - `geoScan {radius}` (agent 0.3.3, radius 1-16): with an Advanced Peripherals Geo Scanner, sends every non-air block in the cube of that radius as `observe` messages flagged `scan: {radius}` (accepted within the radius instead of only next to the turtle; turtles are left out), then returns `{center, radius, count, cost}`. The server then marks every cell of the cube the scan didn't report as air, only if all `count` blocks were recorded. Fails with `no_scanner`, `pose_unknown`, or AP's reason (e.g. the 2 s cooldown).
   - `place {dir, slot}` (agent 0.3.2): places the item in `slot` (jobs use it for torches) into the adjacent cell, then inspects that cell. Data: `{item}`. Fails with CC's reason (`Cannot place block here`) or `slot N is empty`.
   - Jobs require agent ≥ 0.3.0, which has these ops and the dig guard.
3. **Duplicates.** If a `commandId` is already in `recent`, the agent never runs it again. It re-sends the cached result (`duplicate: true`), or acks `duplicate` if it is still running.
4. **Expiry.** `expiresAt` is server time. The agent corrects for clock skew using `welcome.serverTime` and refuses to *start* an expired command (`rejected`/`expired`). The server expires commands still sitting in its queue.
5. **Held turtles** (paused or e-stopped) reject physical ops (`move/turn/dig/refuel/drop/suck/place`) with `held`. Inspect, calibrate and GPS are still allowed.
6. **Connection loss.** The current atomic op finishes. Nothing else runs, because every action comes from the server. The server marks the in-flight command `unknown` (never "failed" or "succeeded" by assumption) and cancels anything queued; queued commands are **not** replayed after reconnect.

Failure codes: `obstructed out_of_fuel unbreakable nothing_to_dig protected busy held expired invalid no_gps no_scanner pose_unknown no_inventory inventory_full unverified failed internal`. CC's raw reason string travels in `reason`.

## Stop / resume

```
server → stop {stopId, reason: estop | pause}
turtle → stop_ack {stopId, finishing?: commandId}     (immediately)
turtle → snapshot {state.hold = {stopId, reason}}     (after the current op, if any)
server → release {stopId}
turtle → released {stopId}
```

The hold is **persisted** on the turtle and survives reboots. A stop for an offline turtle is reported as **unreachable** (never as delivered) and is delivered when the turtle reconnects.

## Movement journal (agent side)

Before a move or turn, the agent persists `{commandId, op, from, to, fuelBefore}`. After the call returns, it updates its pose and clears the journal. On boot with a journal still present:

| Evidence | Conclusion |
|---|---|
| fuel = fuelBefore − 1 | the move happened → pose = `to` |
| fuel = fuelBefore | the move did not happen → pose = `from` |
| unlimited fuel or anything else | **uncertain**; candidates `[from, to]`; needs a GPS fix or manual calibration |
| interrupted turn | heading **uncertain** (turns cost no fuel, so there is no evidence) |

## Observations

```
turtle → observe {blocks: [{x, y, z, name?, state?}]}     (≤ 256 per message; no name = air)
```

The server only accepts cells adjacent (Chebyshev distance ≤ 1) to the turtle's **known** position. Cells a turtle moves into are recorded as known empty, unless already known to be a fluid. Other turtles are not recorded as blocks.

## Turtle state (`snapshot.state`)

`pose {pos?, heading?, position, headingConfidence, source, candidates?}`, `fuel`, `fuelLimit`, `selectedSlot`, `inventory [{slot, name, count}]`, `activity` (`idle working paused unloading returning blocked error`), `hold?`, `currentCommandId?`, `lastError?`.
