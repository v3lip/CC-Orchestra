# Turtle agent (Lua)

| File | Installed as | |
|---|---|---|
| `install.lua` | (run once) | served at `/turtle/install.lua` with the backend URL filled in |
| `fleet/agent.lua` | `/fleet/agent.lua` | the agent: protocol v1, executor, journal, reconnects, status screen |
| `fleet/startup.lua` | `/startup.lua` | launcher; restarts the agent after a crash |

Targets CC: Tweaked 1.100.2 (MC 1.16.5) and uses Lua 5.1 syntax only (checked by `npm test`).
APIs used: `turtle.*`, `http.websocketAsync`/`checkURL`/`get`, `os.epoch/startTimer/cancelTimer/queueEvent/pullEvent`,
`parallel.waitForAny`, `textutils.serializeJSON/unserializeJSON`, `fs`, `gps.locate`, `peripheral.find`, `term`.

The same file runs in tests and in `npm run sim -- --lua` inside a CC-like host (`apps/sim/src/cc`).
Install steps: [docs/minecraft-setup.md](../docs/minecraft-setup.md). Protocol: [docs/protocol.md](../docs/protocol.md).
