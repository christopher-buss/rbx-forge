-- Test-only persistence adapter; shipped App/ServeSession are unchanged.
local actualPlugin = plugin or script:FindFirstAncestorWhichIsA("Plugin")
local values = {
	Rojo_confirmationBehavior = "Initial",
	Rojo_autoReconnect = true,
	Rojo_autoConnectPlaytestServer = true,
	Rojo_priorEndpoints = {
		[tostring(game.PlaceId)] = {
			host = "127.0.0.1",
			port = __FORGE_SYNC_PORT__,
			projectName = __FORGE_SYNC_NAME__,
			timestamp = os.time(),
		},
	},
}
local plugin = {
	GetSetting = function(_, name)
		if values[name] ~= nil then
			return values[name]
		end
		return actualPlugin:GetSetting(name)
	end,
	SetSetting = function(_, name, value)
		values[name] = value
	end,
}
