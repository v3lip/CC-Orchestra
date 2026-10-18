-- CC Fleet installer. The backend fills in BASE when it serves this file.
--   install <PAIRING-CODE>   first install / re-pair
--   install                  update the agent files, keep identity and position
local BASE = "__BASE_URL__"
local args = { ... }
local code = args[1]

local function fail(msg)
  printError(msg)
  error("install failed", 0)
end

local function get(url)
  local res, err = http.get(url)
  if not res then fail("Download failed: " .. url .. " (" .. tostring(err) .. ")") end
  local body = res.readAll()
  res.close()
  return body
end

local function writeFile(path, s)
  local h, err = fs.open(path, "w")
  if not h then fail("Cannot write " .. path .. ": " .. tostring(err)) end
  h.write(s)
  h.close()
end

local function readFile(path)
  if not fs.exists(path) then return nil end
  local h = fs.open(path, "r")
  local s = h.readAll()
  h.close()
  return s
end

print("CC Fleet installer")
if not turtle then fail("This must run on a turtle.") end
if not http then fail("The HTTP API is disabled in the server config (http.enabled).") end

local ok, err = http.checkURL(BASE .. "/turtle/manifest.json")
if not ok then
  printError("Cannot use " .. BASE .. ": " .. tostring(err))
  print("If the domain is 'not permitted', add an allow rule for this")
  print("host and port ABOVE the $private deny rule in")
  print("serverconfig/computercraft-server.toml (see docs).")
  error("install failed", 0)
end

local manifest = textutils.unserializeJSON(get(BASE .. "/turtle/manifest.json"))
if type(manifest) ~= "table" or type(manifest.files) ~= "table" then fail("Bad manifest from server.") end

local stateFile = "/fleet/state.json"
local state = textutils.unserializeJSON(readFile(stateFile) or "") or nil
local hasCreds = type(state) == "table" and type(state.creds) == "table"
if not code and not hasCreds then fail("Usage: install <PAIRING-CODE>  (create a code in the dashboard: Add turtle)") end

if not fs.exists("/fleet") then fs.makeDir("/fleet") end

-- Keep someone else's startup program instead of silently replacing it.
local existing = readFile("/startup.lua")
if existing and not existing:find("CC Fleet launcher", 1, true) and not fs.exists("/startup.lua.bak") then
  fs.move("/startup.lua", "/startup.lua.bak")
  print("Existing startup.lua saved as startup.lua.bak")
end

for _, f in ipairs(manifest.files) do
  print("Downloading " .. f.dest)
  local body = get(BASE .. "/turtle/" .. f.src)
  writeFile(f.dest .. ".new", body)
  if fs.exists(f.dest) then fs.delete(f.dest) end
  fs.move(f.dest .. ".new", f.dest)
end

local wsUrl = BASE:gsub("^http", "ws") .. "/ws/turtle"
writeFile("/fleet/config.json", textutils.serializeJSON({ server = BASE, ws = wsUrl }))

if code then
  -- Re-pairing replaces the identity but keeps the position the turtle knows.
  writeFile("/fleet/enroll.json", textutils.serializeJSON({ code = code }))
  if hasCreds then
    state.creds = nil
    state.recent = nil
    state.seq = (state.seq or 0) + 1
    writeFile(stateFile, textutils.serializeJSON(state))
  end
end

-- Offer calibration when the turtle does not know where it is.
local poseKnown = type(state) == "table" and type(state.pose) == "table" and state.pose.position == "known"
if not poseKnown then
  print("")
  print("Calibrate position now? Stand by the turtle,")
  print("press F3 and enter its block coords and the")
  print("direction its FRONT faces, e.g.: 120 64 -35 n")
  print("Leave empty to skip (calibrate in the dashboard).")
  write("> ")
  local input = read()
  local x, y, z, f = input:match("^%s*(-?%d+)%s+(-?%d+)%s+(-?%d+)%s+(%a+)%s*$")
  local headings = { n = 0, north = 0, e = 1, east = 1, s = 2, south = 2, w = 3, west = 3 }
  local h = f and headings[f:lower()]
  if x and h then
    state = type(state) == "table" and state or {}
    state.pose = {
      pos = { x = tonumber(x), y = tonumber(y), z = tonumber(z) },
      heading = h,
      position = "known",
      headingConfidence = "known",
      source = "manual",
    }
    state.seq = (state.seq or 0) + 1
    writeFile(stateFile, textutils.serializeJSON(state))
    print("Calibrated.")
  elseif input ~= "" then
    print("Not understood; skipping. Calibrate in the dashboard.")
  end
end

print("Installed CC Fleet agent " .. tostring(manifest.version) .. ".")
print("Starting...")
shell.run("/startup.lua")
