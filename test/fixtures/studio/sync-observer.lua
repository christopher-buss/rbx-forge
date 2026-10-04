-- Bounded RunScript observer: no persisted instances or settings.
local HttpService = game:GetService("HttpService")
HttpService.HttpEnabled = true
local endpoint = __FORGE_OBSERVER_URL__
task.spawn(function()
	local deadline = os.clock() + 180
	local requestThread
	local sequence = 0
	while os.clock() < deadline do
		if requestThread == nil or coroutine.status(requestThread) == "dead" then
			sequence += 1
			local probe = workspace:FindFirstChild("ForgeSyncProbe")
			local value = if probe and probe:IsA("StringValue") then probe.Value else ""
			local query = "?name=" .. HttpService:UrlEncode(game.Name)
				.. "&value=" .. HttpService:UrlEncode(value)
				.. "&connection=" .. HttpService:UrlEncode(workspace:GetAttribute("__Rojo_ConnectionUrl") or "")
				.. "&sequence=" .. tostring(sequence)
			requestThread = task.spawn(function()
				pcall(HttpService.GetAsync, HttpService, endpoint .. query, true)
			end)
		end
		task.wait(0.5)
	end
	if requestThread and coroutine.status(requestThread) ~= "dead" then
		pcall(task.cancel, requestThread)
	end
end)
