-- A small stand-in for CC: Tweaked's ROM, so the real turtle agent can run under
-- Node (Lua 5.4 via wasmoon). It models the parts the agent uses: the event queue,
-- os/parallel/sleep, fs, http + websockets, turtle, gps, peripheral, term and
-- textutils JSON (including CC 1.100's refusal to serialise a table twice).
-- Host functions (__*) are provided by host.ts and only take/return primitives.

local unpack = table.unpack

---------------------------------------------------------------- events / os

local co, filter

os.pullEventRaw = function(f) return coroutine.yield(f) end
os.pullEvent = function(f)
  local e = table.pack(os.pullEventRaw(f))
  if e[1] == "terminate" then error("Terminated", 0) end
  return unpack(e, 1, e.n)
end
os.queueEvent = function(name, a, b, c) __queue_event(name, a, b, c) end
os.startTimer = function(s) return __start_timer(s) end
os.cancelTimer = function(id) __cancel_timer(id) end
os.epoch = function() return __epoch() end
os.clock = function() return __epoch() / 1000 end
os.getComputerID = function() return __computer_id() end
os.computerID = os.getComputerID
os.getComputerLabel = function() return __get_label() end
os.setComputerLabel = function(l) __set_label(l) end
os.reboot = function() __reboot() while true do coroutine.yield("__never") end end
os.shutdown = os.reboot

function sleep(s)
  local t = os.startTimer(s or 0)
  repeat local _, id = os.pullEvent("timer") until id == t
end

---------------------------------------------------------------- parallel (port of CC's)

local function runUntilLimit(routines, limit)
  local count, living = #routines, #routines
  local filters = {}
  local ev = { n = 0 }
  while true do
    for n = 1, count do
      local r = routines[n]
      if r and (filters[r] == nil or filters[r] == ev[1] or ev[1] == "terminate") then
        local ok, param = coroutine.resume(r, unpack(ev, 1, ev.n))
        if not ok then error(param, 0) end
        filters[r] = param
        if coroutine.status(r) == "dead" then
          routines[n] = nil
          living = living - 1
          if living <= limit then return n end
        end
      end
    end
    ev = table.pack(os.pullEventRaw())
  end
end

parallel = {
  waitForAny = function(...)
    local rs = {}
    for i, f in ipairs({ ... }) do rs[i] = coroutine.create(f) end
    return runUntilLimit(rs, #rs - 1)
  end,
  waitForAll = function(...)
    local rs = {}
    for i, f in ipairs({ ... }) do rs[i] = coroutine.create(f) end
    return runUntilLimit(rs, 0)
  end,
}

---------------------------------------------------------------- textutils JSON (CC 1.100 semantics)

textutils = {}
textutils.empty_json_array = setmetatable({}, { __newindex = function() error("attempt to mutate textutils.empty_json_array", 2) end })
textutils.json_null = setmetatable({}, { __newindex = function() error("attempt to mutate textutils.json_null", 2) end })

local function encodeString(s)
  return '"' .. s:gsub('[%c"\\]', function(c)
    if c == '"' then return '\\"' elseif c == "\\" then return "\\\\" elseif c == "\n" then return "\\n"
    elseif c == "\r" then return "\\r" elseif c == "\t" then return "\\t" end
    return string.format("\\u%04x", c:byte())
  end) .. '"'
end

local function encode(t, tracking)
  local ty = type(t)
  if t == textutils.empty_json_array then return "[]" end
  if t == textutils.json_null then return "null" end
  if ty == "table" then
    -- CC 1.100 never clears this mark, so a table used twice (even non-recursively) fails.
    if tracking[t] ~= nil then error("Cannot serialize table with recursive entries", 0) end
    tracking[t] = true
    if next(t) == nil then return "{}" end
    local obj, arr = {}, {}
    for k, v in pairs(t) do
      if type(k) == "string" then obj[#obj + 1] = encodeString(k) .. ":" .. encode(v, tracking) end
    end
    for _, v in ipairs(t) do arr[#arr + 1] = encode(v, tracking) end
    if #obj > 0 or #arr == 0 then return "{" .. table.concat(obj, ",") .. "}" end
    return "[" .. table.concat(arr, ",") .. "]"
  elseif ty == "string" then
    return encodeString(t)
  elseif ty == "number" then
    if t ~= t or t == math.huge or t == -math.huge then error("Cannot serialize " .. tostring(t), 0) end
    if math.type(t) == "float" and t == math.floor(t) and math.abs(t) < 2^53 then return string.format("%d", t) end
    return tostring(t)
  elseif ty == "boolean" then
    return tostring(t)
  end
  error("Cannot serialize type " .. ty, 0)
end

textutils.serializeJSON = function(t) return encode(t, {}) end
textutils.serialiseJSON = textutils.serializeJSON

local function decoder(s)
  local i = 1
  local function ws() i = s:find("[^ \t\r\n]", i) or (#s + 1) end
  local value
  local function str()
    i = i + 1
    local out = {}
    while true do
      local c = s:sub(i, i)
      if c == "" then error("unterminated string") end
      if c == '"' then i = i + 1 break end
      if c == "\\" then
        local n = s:sub(i + 1, i + 1)
        local map = { b = "\b", f = "\f", n = "\n", r = "\r", t = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }
        if n == "u" then
          local code = tonumber(s:sub(i + 2, i + 5), 16)
          out[#out + 1] = code < 128 and string.char(code) or utf8.char(code)
          i = i + 6
        else
          out[#out + 1] = map[n]
          i = i + 2
        end
      else
        out[#out + 1] = c
        i = i + 1
      end
    end
    return table.concat(out)
  end
  value = function()
    ws()
    local c = s:sub(i, i)
    if c == "{" then
      i = i + 1
      local t = {}
      ws()
      if s:sub(i, i) == "}" then i = i + 1 return t end
      while true do
        ws()
        local k = str()
        ws()
        assert(s:sub(i, i) == ":", "expected :")
        i = i + 1
        t[k] = value()
        ws()
        local d = s:sub(i, i)
        i = i + 1
        if d == "}" then return t end
        assert(d == ",", "expected , or }")
      end
    elseif c == "[" then
      i = i + 1
      ws()
      if s:sub(i, i) == "]" then i = i + 1 return textutils.empty_json_array end
      local t = {}
      while true do
        t[#t + 1] = value()
        ws()
        local d = s:sub(i, i)
        i = i + 1
        if d == "]" then return t end
        assert(d == ",", "expected , or ]")
      end
    elseif c == '"' then
      return str()
    elseif s:sub(i, i + 3) == "true" then i = i + 4 return true
    elseif s:sub(i, i + 4) == "false" then i = i + 5 return false
    elseif s:sub(i, i + 3) == "null" then i = i + 4 return nil
    else
      local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
      assert(num and #num > 0, "unexpected character")
      i = i + #num
      return tonumber(num)
    end
  end
  return value
end

textutils.unserializeJSON = function(s)
  if type(s) ~= "string" then error("bad argument #1 (string expected)", 2) end
  local ok, v = pcall(decoder(s))
  if not ok then return nil, tostring(v) end
  return v
end
textutils.unserialiseJSON = textutils.unserializeJSON

---------------------------------------------------------------- fs (in-memory, host-backed)

local function norm(p) return (tostring(p):gsub("^/+", "")) end

fs = {}
fs.exists = function(p) return __fs_exists(norm(p)) end
fs.isDir = function(p) return __fs_is_dir(norm(p)) end
fs.makeDir = function(p) __fs_mkdir(norm(p)) end
fs.delete = function(p) __fs_delete(norm(p)) end
fs.move = function(a, b)
  a, b = norm(a), norm(b)
  if not __fs_exists(a) then error("No such file", 2) end
  if __fs_exists(b) then error("File exists", 2) end
  __fs_write(b, __fs_read(a))
  __fs_delete(a)
end
fs.open = function(p, mode)
  p = norm(p)
  if mode == "r" then
    local s = __fs_read(p)
    if s == nil then return nil, "/" .. p .. ": No such file" end
    local pos = 1
    return {
      readAll = function() local r = s:sub(pos) pos = #s + 1 return r end,
      readLine = function()
        if pos > #s then return nil end
        local e = s:find("\n", pos, true) or (#s + 1)
        local r = s:sub(pos, e - 1) pos = e + 1 return r
      end,
      close = function() end,
    }
  elseif mode == "w" or mode == "a" then
    local buf = { mode == "a" and (__fs_read(p) or "") or "" }
    __fs_write(p, buf[1]) -- opening for write truncates immediately, like CC
    local function flush() __fs_write(p, table.concat(buf)) end
    return {
      write = function(x) buf[#buf + 1] = tostring(x) end,
      writeLine = function(x) buf[#buf + 1] = tostring(x) .. "\n" end,
      flush = flush,
      close = flush,
    }
  end
  error("unsupported mode " .. tostring(mode), 2)
end

function dofile(path)
  local src = __fs_read(norm(path))
  if not src then error("File not found: " .. tostring(path), 2) end
  local fn, err = load(src, "@/" .. norm(path))
  if not fn then error(err, 0) end
  return fn()
end

---------------------------------------------------------------- http

local function wsHandle(url, id)
  return {
    send = function(m)
      local r = __ws_send(id, tostring(m))
      if r ~= "ok" then error(r, 2) end
    end,
    close = function() __ws_close(id) end,
  }
end

http = {
  checkURL = function(url) return __http_check(url) end,
  websocketAsync = function(url) __ws_open(url) end,
  websocket = function(url)
    __ws_open(url)
    while true do
      local e, u, h = os.pullEvent()
      if e == "websocket_success" and u == url then return h end
      if e == "websocket_failure" and u == url then return false, h end
    end
  end,
  get = function(url)
    __http_get(url)
    while true do
      local e, u, h = os.pullEvent()
      if e == "http_success" and u == url then return h end
      if e == "http_failure" and u == url then return nil, h end
    end
  end,
}

---------------------------------------------------------------- turtle / gps / peripheral / term

local function task(name, a)
  local id = __turtle_task(name, a)
  while true do
    local _, rid, ok, payload = os.pullEvent("turtle_response")
    if rid == id then return ok, payload end
  end
end

local function inspector(name)
  return function()
    local ok, payload = task(name)
    if ok then return true, textutils.unserializeJSON(payload) end
    return false, payload
  end
end

turtle = {
  forward = function() return task("forward") end,
  back = function() return task("back") end,
  up = function() return task("up") end,
  down = function() return task("down") end,
  turnLeft = function() return task("turnLeft") end,
  turnRight = function() return task("turnRight") end,
  dig = function() return task("dig") end,
  digUp = function() return task("digUp") end,
  digDown = function() return task("digDown") end,
  inspect = inspector("inspect"),
  inspectUp = inspector("inspectUp"),
  inspectDown = inspector("inspectDown"),
  refuel = function(n) return task("refuel", n) end,
  select = function(s)
    if type(s) ~= "number" or s < 1 or s > 16 then error("Slot out of range", 2) end
    __turtle_select(s) return true
  end,
  getSelectedSlot = function() return __turtle_selected() end,
  getFuelLevel = function() return __turtle_fuel() end,
  getFuelLimit = function() return __turtle_fuel_limit() end,
  getItemDetail = function(s)
    local j = __turtle_item(s or __turtle_selected())
    return j and textutils.unserializeJSON(j) or nil
  end,
  getItemCount = function(s)
    local d = turtle.getItemDetail(s)
    return d and d.count or 0
  end,
}

gps = {
  locate = function()
    local s = __gps()
    if not s then return nil end
    local x, y, z = s:match("^(-?%d+),(-?%d+),(-?%d+)$")
    return tonumber(x), tonumber(y), tonumber(z)
  end,
}

peripheral = {
  find = function(ty)
    if ty == "modem" and __has_modem() then return { isWireless = function() return true end } end
    return nil
  end,
}

local noop = function() end
term = {
  clear = noop, clearLine = noop, setCursorPos = noop, write = noop, setTextColor = noop,
  setTextColour = noop, setBackgroundColor = noop,
  getSize = function() return 39, 13 end,
  isColor = function() return false end,
}
colors = { white = 1, red = 16384, green = 8192, yellow = 16 }
colours = colors

function print(...)
  local parts = {}
  for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
  __print(table.concat(parts, "\t"))
end
function write(s) __print(tostring(s)) end
function printError(s) __print("ERROR " .. tostring(s)) end
function read() return __read() or "" end

shell = {
  run = function(path, ...)
    local ok, err = pcall(dofile, path, ...)
    if not ok then printError(err) end
    return ok
  end,
}

---------------------------------------------------------------- driver (called by the host)

local function resume(ev)
  local ok, res = coroutine.resume(co, unpack(ev, 1, ev.n))
  if not ok then return "error:" .. tostring(res) end
  if coroutine.status(co) == "dead" then return "dead" end
  filter = res
  return "running"
end

function __boot(path, argsJson)
  local src = __fs_read(norm(path))
  if not src then return "error:no such program " .. path end
  local fn, err = load(src, "@/" .. norm(path))
  if not fn then return "error:" .. tostring(err) end
  local args = textutils.unserializeJSON(argsJson or "[]")
  if args == textutils.empty_json_array or type(args) ~= "table" then args = {} end
  co = coroutine.create(function() return fn(unpack(args)) end)
  return resume({ n = 0 })
end

function __deliver(name, a, b, c)
  if co == nil or coroutine.status(co) == "dead" then return "dead" end
  if filter ~= nil and filter ~= name and name ~= "terminate" then return "skipped" end
  local ev = { name, a, b, c, n = 4 }
  if name == "websocket_success" then ev[3] = wsHandle(a, b) end
  if name == "http_success" then
    local body = b
    ev[3] = { readAll = function() return body end, close = function() end, getResponseCode = function() return 200 end }
  end
  return resume(ev)
end
