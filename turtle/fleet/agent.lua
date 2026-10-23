-- CC Orchestra turtle agent (protocol v1).
-- Target: CC: Tweaked 1.100.2+ on Minecraft 1.16.5. Lua 5.1 syntax only.
--
-- The agent executes only whitelisted atomic operations sent by the backend.
-- Rules (see docs/protocol.md):
--   * one command at a time; refuse while busy or held (paused / e-stopped)
--   * persist a movement journal BEFORE moving and the result AFTER
--   * on boot, settle an interrupted move using the fuel level as evidence
--   * remember recent command ids so a re-delivered command never runs twice
--   * when the connection drops, finish the current atomic op, then do nothing

local AGENT_VERSION = "lua-0.3.3"
local PROTOCOL = 1
local DIR = "/fleet"
local CONFIG_FILE = DIR .. "/config.json"
local ENROLL_FILE = DIR .. "/enroll.json"
local STATE_FILE = DIR .. "/state.json"
local MAX_RECENT = 16
local MAX_OBSERVATIONS = 256
local WATCHDOG_SECONDS = 20
local CONNECT_TIMEOUT = 15

local unpack = table.unpack or unpack

---------------------------------------------------------------- utilities

local function now()
  return os.epoch("utc")
end

local function readFile(path)
  if not fs.exists(path) then return nil end
  local h = fs.open(path, "r")
  if not h then return nil end
  local s = h.readAll()
  h.close()
  return s
end

local function writeFile(path, s)
  local h, err = fs.open(path, "w")
  if not h then error("cannot write " .. path .. ": " .. tostring(err), 0) end
  h.write(s)
  h.close()
end

local function decode(s)
  if type(s) ~= "string" or s == "" then return nil end
  local ok, v = pcall(textutils.unserializeJSON, s)
  if ok and type(v) == "table" then return v end
  return nil
end

-- serializeJSON on CC 1.100 refuses a table that appears twice in one structure,
-- so every vector stored in state is a fresh copy.
local function vec(v)
  if v == nil then return nil end
  return { x = v.x, y = v.y, z = v.z }
end

local function copyPose(p)
  local c = {
    position = p.position,
    headingConfidence = p.headingConfidence,
    source = p.source,
    pos = vec(p.pos),
    heading = p.heading,
  }
  if p.candidates then
    c.candidates = {}
    for i, v in ipairs(p.candidates) do c.candidates[i] = vec(v) end
  end
  return c
end

local function isInt(n, lo, hi)
  return type(n) == "number" and n == math.floor(n) and (lo == nil or n >= lo) and (hi == nil or n <= hi)
end

---------------------------------------------------------------- config & persistent state

local config = decode(readFile(CONFIG_FILE))
if not config or type(config.ws) ~= "string" then
  error("CC Orchestra is not installed (missing " .. CONFIG_FILE .. "). Run the installer.", 0)
end

local unknownPose = { position = "unknown", headingConfidence = "unknown", source = "none" }

-- mem: { seq, creds = {turtleId, secret}, pose, journal, recent = {...}, hold }
local mem

-- Atomic-ish save: write a temp file, then replace. On load, the copy with the
-- highest sequence number that parses wins, so a crash at any point leaves a valid copy.
local function saveState()
  mem.seq = (mem.seq or 0) + 1
  writeFile(STATE_FILE .. ".tmp", textutils.serializeJSON(mem))
  if fs.exists(STATE_FILE) then fs.delete(STATE_FILE) end
  fs.move(STATE_FILE .. ".tmp", STATE_FILE)
end

local function loadState()
  local a = decode(readFile(STATE_FILE))
  local b = decode(readFile(STATE_FILE .. ".tmp"))
  if b and (not a or (b.seq or 0) > (a.seq or 0)) then return b end
  return a
end

---------------------------------------------------------------- runtime state

local bootId = string.format("%x%04x", now() % 0x100000000, math.random(0, 0xffff))
local ws = nil            -- websocket handle while connected
local authed = false      -- welcome received
local connState = "starting"
local fatal = nil         -- set when the server refuses our credentials
local clockOffset = 0     -- serverTime - localTime, from welcome
local heartbeatSeconds = 5
local scanOnMove = true
-- Blocks never dug without `force` (substring match). Updated from the server on welcome.
local protectedBlocks = { "chest", "barrel", "shulker_box", "computercraft:", "spawner", "_bed", "portal", "hopper", "furnace" }
local serverName = nil
local busy = nil          -- { id, op, args, cancelled, started }
local activity = "idle"
local lastError = nil
local lastResult = nil    -- for the status screen
local wantBootScan = false
local msgSeq = 0

---------------------------------------------------------------- geometry

local HEADING_VEC = { [0] = { 0, -1 }, { 1, 0 }, { 0, 1 }, { -1, 0 } }
local HEADING_NAME = { [0] = "N", "E", "S", "W" }

local function stepFor(op, heading)
  if op == "up" then return { x = 0, y = 1, z = 0 } end
  if op == "down" then return { x = 0, y = -1, z = 0 } end
  if heading == nil then return nil end
  local v = HEADING_VEC[heading]
  if op == "forward" then return { x = v[1], y = 0, z = v[2] } end
  if op == "back" then return { x = -v[1], y = 0, z = -v[2] } end
  return nil
end

local function add(a, b)
  return { x = a.x + b.x, y = a.y + b.y, z = a.z + b.z }
end

local function adjacent(dir)
  local p = mem.pose.pos
  if dir == "up" then return { x = p.x, y = p.y + 1, z = p.z } end
  if dir == "down" then return { x = p.x, y = p.y - 1, z = p.z } end
  return add(p, stepFor("forward", mem.pose.heading))
end

---------------------------------------------------------------- recent commands

local function findRecent(id)
  for _, r in ipairs(mem.recent) do
    if r.commandId == id then return r end
  end
  return nil
end

local function remember(id, status, code, reason)
  local r = findRecent(id)
  if r then
    r.status, r.code, r.reason = status, code, reason
  else
    table.insert(mem.recent, { commandId = id, status = status, code = code, reason = reason })
    while #mem.recent > MAX_RECENT do table.remove(mem.recent, 1) end
  end
end

---------------------------------------------------------------- boot reconciliation

local MOVE_OPS = { forward = true, back = true, up = true, down = true }
local TURN_OPS = { turnLeft = true, turnRight = true }

local function reconcileJournal(j)
  local r = findRecent(j.commandId)
  local function settle(status, reason)
    if r then r.status, r.reason = status, reason end
  end
  if MOVE_OPS[j.op] then
    if not j.from then
      settle("unknown", "rebooted during a move with unknown position")
      return
    end
    local fuel = turtle.getFuelLevel()
    if type(fuel) == "number" and type(j.fuelBefore) == "number" then
      if fuel == j.fuelBefore - 1 and j.to then
        mem.pose.pos = vec(j.to)
        mem.pose.position = "known"
        mem.pose.candidates = nil
        settle("succeeded", "move completed before reboot (fuel decreased by 1)")
        return
      elseif fuel == j.fuelBefore then
        mem.pose.pos = vec(j.from)
        mem.pose.candidates = nil
        settle("cancelled", "move did not happen before reboot (fuel unchanged)")
        return
      end
    end
    -- Unlimited fuel or inconsistent evidence: never guess.
    mem.pose.pos = vec(j.from)
    mem.pose.position = "uncertain"
    mem.pose.candidates = { vec(j.from) }
    if j.to then table.insert(mem.pose.candidates, vec(j.to)) end
    settle("unknown", "rebooted during a move; position must be reconciled")
  elseif TURN_OPS[j.op] then
    -- Turning costs no fuel, so there is no evidence either way.
    if mem.pose.heading ~= nil then mem.pose.headingConfidence = "uncertain" end
    settle("unknown", "rebooted during a turn; heading must be recalibrated")
  end
end

local function boot()
  mem = loadState() or {}
  mem.recent = mem.recent or {}
  mem.pose = mem.pose and copyPose(mem.pose) or copyPose(unknownPose)
  if mem.journal then
    reconcileJournal(mem.journal)
    mem.journal = nil
  end
  for _, r in ipairs(mem.recent) do
    if r.status == "running" then r.status = "unknown" end
  end
  activity = mem.hold and "paused" or "idle"
  saveState()
end

---------------------------------------------------------------- telemetry

local function inventory()
  local items = {}
  for slot = 1, 16 do
    local d = turtle.getItemDetail(slot)
    if d then items[#items + 1] = { slot = slot, name = d.name, count = d.count } end
  end
  return items
end

-- Peripheral type of each upgrade side (nil for tools such as the pickaxe).
-- Advanced Peripherals' Chunk Controller reports "chunky".
local function upgrades()
  local u = {}
  for _, side in ipairs({ "left", "right" }) do
    local t = peripheral.getType(side)
    if type(t) == "string" then u[side] = t end
  end
  return u
end

local function stateTable()
  local hold = nil
  if mem.hold then hold = { stopId = mem.hold.stopId, reason = mem.hold.reason } end
  return {
    pose = copyPose(mem.pose),
    fuel = turtle.getFuelLevel(),
    fuelLimit = turtle.getFuelLimit(),
    selectedSlot = turtle.getSelectedSlot(),
    inventory = inventory(),
    activity = activity,
    hold = hold,
    currentCommandId = busy and busy.id or nil,
    lastError = lastError,
    upgrades = upgrades(),
  }
end

local function redraw()
  os.queueEvent("fleet_redraw")
end

local function send(t)
  if not ws then return false end
  msgSeq = msgSeq + 1
  t.v = PROTOCOL
  t.id = bootId .. "-" .. msgSeq
  t.ts = now()
  local ok = pcall(ws.send, textutils.serializeJSON(t))
  return ok
end

local function sendState()
  if authed then send({ type = "snapshot", state = stateTable() }) end
  redraw()
end

local function sendHello()
  local recent = {}
  for i, r in ipairs(mem.recent) do recent[i] = { commandId = r.commandId, status = r.status } end
  send({
    type = "hello",
    turtleId = mem.creds.turtleId,
    secret = mem.creds.secret,
    computerId = os.getComputerID(),
    label = os.getComputerLabel(),
    agent = { kind = "lua", version = AGENT_VERSION },
    bootId = bootId,
    recent = recent,
  })
end

---------------------------------------------------------------- observations

local INSPECT = { front = "inspect", up = "inspectUp", down = "inspectDown" }

-- Inspect directions and report what is there. Only reported when the pose is known
-- (the server rejects observations that are not next to the turtle's known position).
local function scan(dirs)
  local pose = mem.pose
  local blocks = {}
  for _, dir in ipairs(dirs) do
    local ok, data = turtle[INSPECT[dir]]()
    local canReport = pose.position == "known" and pose.pos ~= nil
      and (dir ~= "front" or (pose.headingConfidence == "known" and pose.heading ~= nil))
    -- Other turtles move; never put them on the map.
    local isTurtle = ok and type(data) == "table" and type(data.name) == "string" and data.name:find("^computercraft:turtle") ~= nil
    if canReport and not isTurtle then
      local c = adjacent(dir)
      if ok and type(data) == "table" then
        local state = nil
        if type(data.state) == "table" then
          state = {}
          for k, v in pairs(data.state) do
            local tv = type(v)
            if type(k) == "string" and (tv == "string" or tv == "number" or tv == "boolean") then state[k] = v end
          end
        end
        c.name = data.name
        c.state = state
      end
      blocks[#blocks + 1] = c
    end
  end
  if #blocks > 0 and #blocks <= MAX_OBSERVATIONS and authed then
    send({ type = "observe", blocks = blocks })
  end
end

---------------------------------------------------------------- operations

local function okResult(data)
  return { ok = true, data = data }
end

local function classify(reason)
  local r = string.lower(tostring(reason or ""))
  if r:find("obstructed") then return "obstructed" end
  if r:find("out of fuel") then return "out_of_fuel" end
  if r:find("unbreakable") then return "unbreakable" end
  if r:find("nothing to dig") then return "nothing_to_dig" end
  if r:find("protected") then return "protected" end
  return "failed"
end

local function fail(code, reason)
  return { ok = false, code = code, reason = reason }
end

local function doMove(cmd)
  local op = cmd.op
  local fuel = turtle.getFuelLevel()
  if fuel ~= "unlimited" and fuel <= 0 then return fail("out_of_fuel", "Out of fuel") end
  local pose = mem.pose
  local step = stepFor(op, pose.heading)
  local to = nil
  if pose.pos and step then to = add(pose.pos, step) end
  mem.journal = { commandId = cmd.id, op = op, from = vec(pose.pos), to = vec(to), fuelBefore = fuel }
  saveState()

  local ok, reason = turtle[op]()

  if ok then
    local vertical = op == "up" or op == "down"
    if to and pose.position == "known" and (vertical or pose.headingConfidence == "known") then
      pose.pos = to
      if pose.source == "none" then pose.source = "tracked" end
    elseif pose.pos then
      pose.position = "uncertain"
      pose.candidates = nil
    end
  end
  mem.journal = nil
  saveState()
  sendState() -- the server checks observations against the latest pose
  if ok then
    if scanOnMove then scan({ "front", "up", "down" }) end
    return okResult()
  end
  local dir = (op == "up" and "up") or (op == "down" and "down") or (op == "forward" and "front") or nil
  if dir and classify(reason) == "obstructed" then scan({ dir }) end
  return fail(classify(reason), reason)
end

local function doTurn(cmd)
  local pose = mem.pose
  mem.journal = { commandId = cmd.id, op = cmd.op, fuelBefore = turtle.getFuelLevel() }
  saveState()
  local ok, reason = turtle[cmd.op]()
  if ok and pose.heading ~= nil then
    if cmd.op == "turnRight" then pose.heading = (pose.heading + 1) % 4 else pose.heading = (pose.heading + 3) % 4 end
  end
  mem.journal = nil
  saveState()
  sendState()
  if not ok then return fail(classify(reason), reason) end
  if scanOnMove then scan({ "front" }) end
  return okResult()
end

---------------------------------------------------------------- inventories

local SIDE = { front = "front", up = "top", down = "bottom" }
local DROP = { front = "drop", up = "dropUp", down = "dropDown" }
local SUCK = { front = "suck", up = "suckUp", down = "suckDown" }

-- The adjacent block as an inventory peripheral, or nil. Everything that moves items
-- checks this first: turtle.drop() with no inventory throws the items into the world.
local function inventoryAt(dir)
  local p = peripheral.wrap(SIDE[dir])
  if p and type(p.list) == "function" and type(p.size) == "function" then return p end
  return nil
end

local function countIn(inv, name)
  local ok, list = pcall(inv.list)
  if not ok or type(list) ~= "table" then return nil end
  local n = 0
  for _, it in pairs(list) do
    if type(it) == "table" and it.name == name then n = n + it.count end
  end
  return n
end

local function isProtected(name)
  for _, pat in ipairs(protectedBlocks) do
    if string.find(name, pat, 1, true) then return true end
  end
  return false
end

local function doDrop(cmd)
  local a = cmd.args
  if not inventoryAt(a.dir) then
    return fail("no_inventory", "no inventory " .. a.dir .. "; refusing to drop items into the world")
  end
  local item = turtle.getItemDetail(a.slot)
  if not item then return okResult({ dropped = 0 }) end
  local inv = inventoryAt(a.dir)
  local chestBefore = countIn(inv, item.name)
  turtle.select(a.slot)
  -- Check again right before dropping: the chest might have just been removed.
  if not inventoryAt(a.dir) then
    return fail("no_inventory", "inventory " .. a.dir .. " disappeared; nothing dropped")
  end
  local ok, reason
  if a.count then ok, reason = turtle[DROP[a.dir]](a.count) else ok, reason = turtle[DROP[a.dir]]() end
  local after = turtle.getItemDetail(a.slot)
  local left = (after and after.name == item.name) and after.count or 0
  local dropped = item.count - left
  if dropped <= 0 then
    return fail("inventory_full", tostring(reason or "the inventory accepted nothing"))
  end
  local chestAfter = countIn(inv, item.name)
  local gain = nil
  if chestBefore and chestAfter then gain = chestAfter - chestBefore end
  local want = a.count or item.count
  return okResult({
    item = item.name,
    dropped = dropped,
    requested = want,
    partial = dropped < want,
    chestGain = gain,
    verified = gain == dropped,
  })
end

local function doSuck(cmd)
  local a = cmd.args
  if not inventoryAt(a.dir) then return fail("no_inventory", "no inventory " .. a.dir) end
  local before = {}
  for s = 1, 16 do before[s] = turtle.getItemCount(s) end
  turtle.select(a.slot)
  local ok, reason
  if a.count then ok, reason = turtle[SUCK[a.dir]](a.count) else ok, reason = turtle[SUCK[a.dir]]() end
  local taken, slots = 0, {}
  for s = 1, 16 do
    local d = turtle.getItemCount(s) - before[s]
    if d > 0 then
      taken = taken + d
      local it = turtle.getItemDetail(s)
      slots[#slots + 1] = { slot = s, name = it and it.name or "?", count = d }
    end
  end
  return okResult({ taken = taken, slots = slots, reason = (not ok) and tostring(reason) or nil })
end

local PLACE = { front = "place", up = "placeUp", down = "placeDown" }

-- Place the item in a slot (a torch, for jobs) into the adjacent cell, then look at it.
local function doPlace(cmd)
  local a = cmd.args
  local item = turtle.getItemDetail(a.slot)
  if not item then return fail("failed", "slot " .. a.slot .. " is empty") end
  turtle.select(a.slot)
  local ok, reason = turtle[PLACE[a.dir]]()
  scan({ a.dir })
  if not ok then return fail(classify(reason), reason) end
  return okResult({ item = item.name })
end

-- Advanced Peripherals Geo Scanner: report every non-air block within the radius (a
-- cube) as observations flagged with the scan, so the server also knows the rest is air.
local function doGeoScan(cmd)
  local scanner = peripheral.find("geoScanner")
  if not scanner then return fail("no_scanner", "no Geo Scanner equipped") end
  local pose = mem.pose
  if pose.position ~= "known" or not pose.pos then return fail("pose_unknown", "position unknown: calibrate first") end
  local r = cmd.args.radius
  local okCost, cost = pcall(scanner.cost, r)
  local ok, res, err = pcall(scanner.scan, r)
  if not ok then return fail("failed", tostring(res)) end
  if type(res) ~= "table" then return fail(classify(err), tostring(err or "scan failed")) end
  local c = pose.pos
  -- AP gives positions relative to the scanner; if a version ever gives absolute ones
  -- (outside the radius), use them as they are.
  local absolute = false
  for _, b in ipairs(res) do
    if type(b) == "table" and (math.abs(b.x or 0) > r or math.abs(b.y or 0) > r or math.abs(b.z or 0) > r) then absolute = true break end
  end
  local batch, count = {}, 0
  for _, b in ipairs(res) do
    -- Other turtles (and this one) move: never map them.
    if type(b) == "table" and type(b.name) == "string" and not b.name:find("^computercraft:turtle") then
      local o = absolute and { x = b.x, y = b.y, z = b.z } or { x = c.x + b.x, y = c.y + b.y, z = c.z + b.z }
      o.name = b.name
      batch[#batch + 1] = o
      count = count + 1
      if #batch >= MAX_OBSERVATIONS then
        send({ type = "observe", blocks = batch, scan = { radius = r } })
        batch = {}
      end
    end
  end
  if #batch > 0 then send({ type = "observe", blocks = batch, scan = { radius = r } }) end
  return okResult({ center = vec(c), radius = r, count = count, cost = okCost and cost or nil })
end

local function doInventoryInfo(cmd)
  local inv = inventoryAt(cmd.args.dir)
  if not inv then return fail("no_inventory", "no inventory " .. cmd.args.dir) end
  local size = inv.size()
  local list = inv.list()
  local used, totals, names = 0, {}, {}
  for _, it in pairs(list) do
    used = used + 1
    if not totals[it.name] then names[#names + 1] = it.name end
    totals[it.name] = (totals[it.name] or 0) + it.count
  end
  local items = {}
  for i = 1, math.min(#names, 32) do items[i] = { name = names[i], count = totals[names[i]] } end
  local okI, data = turtle[INSPECT[cmd.args.dir]]()
  return okResult({ block = okI and type(data) == "table" and data.name or nil, size = size, used = used, free = size - used, items = items })
end

local DIG = { dig = { "dig", "inspect", "front" }, digUp = { "digUp", "inspectUp", "up" }, digDown = { "digDown", "inspectDown", "down" } }

local function doDig(cmd)
  local d = DIG[cmd.op]
  local had, before = turtle[d[2]]()
  -- Never dig anything with an inventory (chests, other turtles...), even with force.
  if inventoryAt(d[3]) then return fail("protected", "refusing to dig a block with an inventory") end
  if had and type(before) == "table" and type(before.name) == "string" and not cmd.args.force and isProtected(before.name) then
    return fail("protected", "protected block " .. before.name)
  end
  local ok, reason = turtle[d[1]]()
  if not ok then return fail(classify(reason), reason) end
  scan({ d[3] }) -- gravel or sand may have fallen into the gap
  return okResult({ block = had and type(before) == "table" and before.name or nil })
end

local INSPECT_OPS = { inspect = "front", inspectUp = "up", inspectDown = "down" }

local function doInspect(cmd)
  local dir = INSPECT_OPS[cmd.op]
  local ok, data = turtle[INSPECT[dir]]()
  scan({ dir })
  if ok and type(data) == "table" then
    local state = {}
    if type(data.state) == "table" then
      for k, v in pairs(data.state) do
        if type(k) == "string" and type(v) ~= "table" then state[k] = v end
      end
    end
    return okResult({ name = data.name, state = state })
  end
  return okResult({ air = true })
end

local function doGps(cmd)
  if not peripheral.find("modem") then return fail("no_gps", "no modem attached (GPS needs a wireless modem)") end
  local x, y, z = gps.locate(cmd.args.timeout or 2)
  if not x then return fail("no_gps", "could not determine position (no GPS hosts in range?)") end
  local pos = { x = math.floor(x + 0.5), y = math.floor(y + 0.5), z = math.floor(z + 0.5) }
  local old = mem.pose.pos
  local agreed = old ~= nil and old.x == pos.x and old.y == pos.y and old.z == pos.z
  -- GPS fixes position only; heading stays whatever it was.
  mem.pose.pos = pos
  mem.pose.position = "known"
  mem.pose.source = "gps"
  mem.pose.candidates = nil
  saveState()
  return okResult({ x = pos.x, y = pos.y, z = pos.z, agreedWithTracking = agreed })
end

local function execute(cmd)
  local op, a = cmd.op, cmd.args
  if MOVE_OPS[op] then return doMove(cmd) end
  if TURN_OPS[op] then return doTurn(cmd) end
  if DIG[op] then return doDig(cmd) end
  if INSPECT_OPS[op] then return doInspect(cmd) end
  if op == "select" then
    turtle.select(a.slot)
    return okResult()
  elseif op == "refuel" then
    local ok, reason
    if a.count ~= nil then ok, reason = turtle.refuel(a.count) else ok, reason = turtle.refuel() end
    if not ok then return fail("failed", reason) end
    return okResult({ fuel = turtle.getFuelLevel() })
  elseif op == "calibrate" then
    mem.pose = {
      pos = { x = a.x, y = a.y, z = a.z },
      heading = a.heading,
      position = "known",
      headingConfidence = "known",
      source = "manual",
    }
    saveState()
    return okResult()
  elseif op == "gpsLocate" then
    return doGps(cmd)
  elseif op == "setLabel" then
    os.setComputerLabel(a.label)
    return okResult()
  elseif op == "drop" then
    return doDrop(cmd)
  elseif op == "suck" then
    return doSuck(cmd)
  elseif op == "inventoryInfo" then
    return doInventoryInfo(cmd)
  elseif op == "place" then
    return doPlace(cmd)
  elseif op == "geoScan" then
    return doGeoScan(cmd)
  end
  return fail("invalid", "unsupported op " .. tostring(op))
end

---------------------------------------------------------------- command validation

local PHYSICAL = {
  forward = true, back = true, up = true, down = true, turnLeft = true, turnRight = true,
  dig = true, digUp = true, digDown = true, refuel = true, drop = true, suck = true, place = true, geoScan = true,
}

local DIRS = { front = true, up = true, down = true }

local VALIDATE = {
  forward = true, back = true, up = true, down = true, turnLeft = true, turnRight = true,
  inspect = true, inspectUp = true, inspectDown = true,
  dig = function(a) return a.force == nil or type(a.force) == "boolean" end,
  digUp = function(a) return a.force == nil or type(a.force) == "boolean" end,
  digDown = function(a) return a.force == nil or type(a.force) == "boolean" end,
  drop = function(a) return DIRS[a.dir] and isInt(a.slot, 1, 16) and (a.count == nil or isInt(a.count, 1, 64)) end,
  suck = function(a) return DIRS[a.dir] and isInt(a.slot, 1, 16) and (a.count == nil or isInt(a.count, 1, 64)) end,
  inventoryInfo = function(a) return DIRS[a.dir] == true end,
  place = function(a) return DIRS[a.dir] and isInt(a.slot, 1, 16) end,
  geoScan = function(a) return isInt(a.radius, 1, 16) end,
  select = function(a) return isInt(a.slot, 1, 16) end,
  refuel = function(a) return a.count == nil or isInt(a.count, 0, 64) end,
  calibrate = function(a) return isInt(a.x) and isInt(a.y) and isInt(a.z) and isInt(a.heading, 0, 3) end,
  gpsLocate = function(a) return a.timeout == nil or (type(a.timeout) == "number" and a.timeout >= 0.5 and a.timeout <= 5) end,
  setLabel = function(a) return type(a.label) == "string" and #a.label >= 1 and #a.label <= 32 end,
}

local function reject(id, code, reason, keep)
  if keep then
    remember(id, "rejected", code, reason)
    saveState()
  end
  send({ type = "ack", commandId = id, status = "rejected", code = code, reason = reason })
end

local function onCommand(msg)
  local id = msg.commandId
  if type(id) ~= "string" then return end
  local seen = findRecent(id)
  if seen then
    -- Duplicate delivery: never execute twice.
    if seen.status == "running" then
      send({ type = "ack", commandId = id, status = "duplicate" })
    elseif seen.status == "succeeded" or seen.status == "failed" or seen.status == "cancelled" then
      send({ type = "result", commandId = id, status = seen.status, code = seen.code, reason = seen.reason, duplicate = true })
    else
      send({ type = "ack", commandId = id, status = "rejected", code = "invalid", reason = "already seen (" .. tostring(seen.status) .. ")" })
    end
    return
  end
  if busy then return reject(id, "busy", "another command is running", false) end
  if type(msg.expiresAt) == "number" and now() + clockOffset > msg.expiresAt then
    return reject(id, "expired", "command expired before it started", true)
  end
  local v = VALIDATE[msg.op]
  local args = type(msg.args) == "table" and msg.args or {}
  if not v then return reject(id, "invalid", "unknown operation " .. tostring(msg.op), true) end
  if v ~= true and not v(args) then return reject(id, "invalid", "invalid arguments for " .. msg.op, true) end
  if mem.hold and PHYSICAL[msg.op] then return reject(id, "held", "held (" .. mem.hold.reason .. ")", true) end

  busy = { id = id, op = msg.op, args = args, cancelled = false, started = false }
  remember(id, "running")
  saveState()
  send({ type = "ack", commandId = id, status = "accepted" })
  os.queueEvent("fleet_exec")
end

---------------------------------------------------------------- executor coroutine

local function runCommand()
  local cmd = busy
  cmd.started = true
  activity = "working"
  redraw()
  local res
  if cmd.cancelled then
    res = { ok = false, cancelled = true, reason = "cancelled before it started" }
  elseif mem.hold and PHYSICAL[cmd.op] then
    -- A stop arrived between acceptance and start.
    res = fail("held", "held (" .. mem.hold.reason .. ") before it started")
  else
    local ok, r = pcall(execute, cmd)
    if not ok then
      if tostring(r):find("Terminated") then error(r, 0) end
      res = fail("internal", tostring(r))
    else
      res = r
    end
  end
  local status = res.ok and "succeeded" or (res.cancelled and "cancelled" or "failed")
  remember(cmd.id, status, res.code, res.reason)
  busy = nil
  if mem.hold then
    activity = "paused"
  elseif res.code == "obstructed" then
    activity = "blocked"
  else
    activity = "idle"
  end
  if status == "failed" then
    lastError = { code = res.code or "failed", message = tostring(res.reason or "failed"), at = now() }
  end
  lastResult = cmd.op .. ": " .. status .. (res.reason and (" (" .. tostring(res.reason) .. ")") or "")
  saveState()
  sendState()
  send({ type = "result", commandId = cmd.id, status = status, code = res.code, reason = res.reason, data = res.data })
end

local function execLoop()
  while true do
    if busy and not busy.started then
      runCommand()
    elseif wantBootScan then
      wantBootScan = false
      scan({ "front", "up", "down" })
    else
      os.pullEvent("fleet_exec")
    end
  end
end

---------------------------------------------------------------- network coroutine

local function handleMessage(raw)
  local msg = decode(raw)
  if not msg or msg.v ~= PROTOCOL then return end
  local t = msg.type
  if t == "enrolled" then
    mem.creds = { turtleId = msg.turtleId, secret = msg.secret }
    saveState()
    if fs.exists(ENROLL_FILE) then fs.delete(ENROLL_FILE) end
    -- A labelled turtle keeps its files when broken and picked up.
    if not os.getComputerLabel() and type(msg.name) == "string" then os.setComputerLabel(msg.name) end
    sendHello()
  elseif t == "welcome" then
    authed = true
    connState = "online"
    serverName = msg.name
    if type(msg.serverTime) == "number" then clockOffset = msg.serverTime - now() end
    if type(msg.heartbeatMs) == "number" and msg.heartbeatMs >= 100 then heartbeatSeconds = msg.heartbeatMs / 1000 end
    if type(msg.config) == "table" then
      scanOnMove = msg.config.scanOnMove ~= false
      if type(msg.config.protectedBlocks) == "table" then
        local list = {}
        for _, v in ipairs(msg.config.protectedBlocks) do
          if type(v) == "string" then list[#list + 1] = v end
        end
        protectedBlocks = list
      end
    end
    sendState()
    if mem.pose.position == "known" then
      wantBootScan = true
      os.queueEvent("fleet_exec")
    end
  elseif t == "denied" then
    local reason = tostring(msg.reason)
    if reason:find("credentials") or reason:find("pairing") then
      fatal = reason
    end
    connState = "denied: " .. reason
    redraw()
  elseif t == "cmd" then
    onCommand(msg)
  elseif t == "cancel" then
    if busy and busy.id == msg.commandId then busy.cancelled = true end
  elseif t == "stop" then
    mem.hold = { stopId = msg.stopId, reason = msg.reason == "pause" and "pause" or "estop" }
    saveState()
    send({ type = "stop_ack", stopId = msg.stopId, finishing = busy and busy.id or nil })
    if not busy then
      activity = "paused"
      sendState()
    end
  elseif t == "release" then
    if mem.hold then
      mem.hold = nil
      saveState()
      if not busy then activity = "idle" end
    end
    send({ type = "released", stopId = msg.stopId })
    sendState()
  end
end

local function session(url)
  local watchdog = os.startTimer(WATCHDOG_SECONDS)
  while true do
    local ev = { os.pullEvent() }
    local name = ev[1]
    if name == "websocket_message" and ev[2] == url then
      os.cancelTimer(watchdog)
      watchdog = os.startTimer(WATCHDOG_SECONDS)
      handleMessage(ev[3])
      if fatal then return end
    elseif name == "websocket_closed" and ev[2] == url then
      return
    elseif name == "websocket_success" and ev[2] == url and ev[3] ~= ws then
      -- A late answer to an earlier, timed-out attempt: we already have a link.
      pcall(ev[3].close)
    elseif name == "timer" and ev[2] == watchdog then
      -- No traffic for several heartbeats: assume the link is dead.
      return
    end
  end
end

local function connectOnce(url)
  connState = "connecting"
  redraw()
  http.websocketAsync(url)
  local timer = os.startTimer(CONNECT_TIMEOUT)
  while true do
    local ev = { os.pullEvent() }
    if ev[1] == "websocket_success" and ev[2] == url then
      os.cancelTimer(timer)
      return ev[3]
    elseif ev[1] == "websocket_failure" and ev[2] == url then
      os.cancelTimer(timer)
      return nil, ev[3]
    elseif ev[1] == "timer" and ev[2] == timer then
      return nil, "connection timed out"
    end
  end
end

local function netLoop()
  local backoff = 1
  local url = config.ws
  while not fatal do
    local handle, err = connectOnce(url)
    if handle then
      ws = handle
      authed = false
      backoff = 1
      if mem.creds then
        sendHello()
      else
        local enroll = decode(readFile(ENROLL_FILE))
        if enroll and type(enroll.code) == "string" then
          send({
            type = "enroll",
            code = enroll.code,
            computerId = os.getComputerID(),
            label = os.getComputerLabel(),
            agent = { kind = "lua", version = AGENT_VERSION },
          })
        else
          fatal = "not paired: run the installer with a pairing code"
        end
      end
      if not fatal then session(url) end
      pcall(ws.close)
      ws = nil
      authed = false
      if not fatal then connState = "offline (reconnecting)" end
    else
      connState = "offline: " .. tostring(err)
    end
    redraw()
    if fatal then break end
    -- Exponential backoff with jitter, capped at 30 s.
    sleep(backoff * (0.75 + math.random() * 0.5))
    backoff = math.min(backoff * 2, 30)
  end
  connState = "stopped: " .. tostring(fatal)
  redraw()
  -- Stay alive (and idle) so the status screen keeps showing why.
  while true do os.pullEvent("fleet_never") end
end

---------------------------------------------------------------- heartbeat & screen

local function heartbeatLoop()
  local seq = 0
  while true do
    sleep(heartbeatSeconds)
    if authed then
      seq = seq + 1
      send({ type = "hb", seq = seq, fuel = turtle.getFuelLevel() })
    end
  end
end

local function line(y, text)
  term.setCursorPos(1, y)
  term.clearLine()
  term.write(text)
end

local function screenLoop()
  while true do
    local w = term.getSize()
    local p = mem.pose
    term.clear()
    line(1, ("CC Orchestra " .. AGENT_VERSION):sub(1, w))
    line(2, ("Name: " .. tostring(serverName or os.getComputerLabel() or "?")):sub(1, w))
    line(3, ("Link: " .. connState):sub(1, w))
    local pos = p.pos and (p.pos.x .. " " .. p.pos.y .. " " .. p.pos.z) or "unknown"
    local hd = p.heading ~= nil and HEADING_NAME[p.heading] or "?"
    line(4, ("Pos:  " .. pos .. " " .. hd .. " [" .. p.position .. "/" .. p.headingConfidence .. "]"):sub(1, w))
    line(5, ("Fuel: " .. tostring(turtle.getFuelLevel())):sub(1, w))
    line(6, ("State: " .. activity .. (mem.hold and (" HOLD:" .. mem.hold.reason) or "")):sub(1, w))
    line(7, ("Last: " .. tostring(lastResult or "-")):sub(1, w))
    if fatal then line(9, ("! " .. fatal):sub(1, w)) end
    line(11, "Ctrl+T stops the agent.")
    local t = os.startTimer(2)
    repeat
      local e, id = os.pullEvent()
    until e == "fleet_redraw" or (e == "timer" and id == t)
  end
end

---------------------------------------------------------------- main

math.randomseed(now())
boot()
parallel.waitForAny(netLoop, execLoop, heartbeatLoop, screenLoop)
