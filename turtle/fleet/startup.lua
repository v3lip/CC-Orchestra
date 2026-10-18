-- CC Fleet launcher (installed as /startup.lua). Restarts the agent if it crashes.
while true do
  local ok, err = pcall(dofile, "/fleet/agent.lua")
  if ok then break end
  if tostring(err):find("Terminated") then
    print("CC Fleet agent stopped (Ctrl+T). Type 'startup' to start it again.")
    break
  end
  printError("CC Fleet agent crashed: " .. tostring(err))
  print("Restarting in 5 seconds...")
  sleep(5)
end
