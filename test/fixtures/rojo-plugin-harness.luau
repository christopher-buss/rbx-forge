-- Full shipped modules run against a deterministic Studio/API model.
local function noop() end
local now = 0
local sleepers = {}
local function resume(thread)
	local ok, err = coroutine.resume(thread)
	assert(ok, err)
end
local tasks = {
	spawn = function(callback) local thread = coroutine.create(callback); resume(thread); return thread end,
	wait = function(seconds) table.insert(sleepers, {thread = coroutine.running(), due = now + seconds}); coroutine.yield() end,
}
tasks.defer = tasks.spawn
local function advance(seconds)
	now += seconds
	local pending = sleepers
	sleepers = {}
	for _, sleeper in pending do
		if sleeper.due <= now then resume(sleeper.thread) else table.insert(sleepers, sleeper) end
	end
end
local Promise = {}
Promise.__index = Promise
function Promise.new(executor)
	local self = setmetatable({state = "pending", handlers = {}}, Promise)
	if executor then tasks.spawn(function()
		local ok, err = pcall(executor, function(value) self:resolve(value) end, function(value) self:reject(value) end)
		if not ok then self:reject(err) end
	end) end
	return self
end
function Promise:resolve(value)
	if self.state ~= "pending" then return end
	if type(value) == "table" and value.andThen then value:andThen(function(result) self:resolve(result) end):catch(function(err) self:reject(err) end); return end
	self.state = "resolved"; self.value = value
	for _, callback in self.handlers do callback() end
end
function Promise:reject(value)
	if self.state ~= "pending" then return end
	self.state = "rejected"; self.value = value
	for _, callback in self.handlers do callback() end
end
function Promise:andThen(success, failure)
	local following = Promise.new()
	local function run()
		if self.state == "cancelled" or following.state == "cancelled" then return end
		local callback = if self.state == "resolved" then success else failure
		if callback then
			local ok, result = pcall(callback, self.value)
			if ok then following:resolve(result) else following:reject(result) end
		elseif self.state == "resolved" then following:resolve(self.value) else following:reject(self.value) end
	end
	if self.state == "pending" then table.insert(self.handlers, run) else run() end
	return following
end
function Promise:catch(callback) return self:andThen(nil, callback) end
function Promise:cancel() self.state = "cancelled" end
function Promise.try(callback) return Promise.new(function(resolve) resolve(callback()) end) end
local function resolved(value) local promise = Promise.new(); promise:resolve(value); return promise end
local function rejected(value) local promise = Promise.new(); promise:reject(value); return promise end
Promise.resolve = resolved
Promise.reject = rejected
-- Resolve/reject are also instance methods; Lua dispatches both through this table.
Promise.resolve = function(self, value)
	if getmetatable(self) ~= Promise then return resolved(self) end
	if self.state ~= "pending" then return end
	if type(value) == "table" and value.andThen then value:andThen(function(result) self:resolve(result) end):catch(function(err) self:reject(err) end); return end
	self.state = "resolved"; self.value = value
	for _, callback in self.handlers do callback() end
end
Promise.reject = function(self, value)
	if getmetatable(self) ~= Promise then return rejected(self) end
	if self.state ~= "pending" then return end
	self.state = "rejected"; self.value = value
	for _, callback in self.handlers do callback() end
end

local function signal()
	local listeners = {}
	return {
		Connect = function(_, callback)
			local entry = {callback = callback, alive = true}; table.insert(listeners, entry)
			return {Disconnect = function() entry.alive = false end}
		end,
		Fire = function(_, value) for _, entry in listeners do if entry.alive then entry.callback(value) end end end,
	}
end
local function node(name)
	return setmetatable({name = name}, {__index = function(self, key) local child = node(key); rawset(self, key, child); return child end})
end
local root = node("Rojo")
local scriptNode = node("App")
scriptNode.FindFirstAncestor = function() return root end
local edit = true
local playtestUrl
local existing
local world = {Name = "Untitled", PlaceId = 0, ChildAdded = signal(), FindFirstChild = function(_, _) return existing end}
local services = setmetatable({}, {__index = function(self, key)
	local value = {GetPropertyChangedSignal = signal, OnUndo = signal(), OnRedo = signal()}
	rawset(self, key, value); return value
end})
services.RunService = {IsEdit = function() return edit end, IsRunning = function() return not edit end, IsStudio = function() return true end, IsServer = function() return true end}
services.StudioService = {GetUserId = function() return 42 end, GetPropertyChangedSignal = signal}
services.ChangeHistoryService.TryBeginRecording = function() return false end
services.Selection.Get = function() return {} end
services.Selection.Set = noop
world.GetService = function(_, name) return services[name] end
local settings = {priorEndpoints = { ["0"] = {host = "old", port = "9", projectName = "Foreign"} }, autoReconnect = true, twoWaySync = false}
local httpRequests = {}
local httpFailure
local reconcileName
local emptyDiff = false
local appClass
local modules = {
	Promise = Promise,
	Roact = {Component = {extend = function() appClass = {}; return appClass end}, createElement = noop, createBinding = function(value)
		local binding = {getValue = function() return value end}; return binding, function(nextValue) value = nextValue end
	end},
	Assets = {Images = {}},
	Log = setmetatable({}, {__index = function() return noop end}),
	strict = function(_, value) return value end,
	t = {table = true, boolean = true, string = true, optional = function(value) return value end, strictInterface = function() return function() return true end end},
	Settings = {get = function(_, key) return settings[key] end, set = function(_, key, value) settings[key] = value end, onChanged = function() return noop end},
	preloadAssets = noop,
	Version = {getUpdateMessage = noop},
	PatchSet = {newEmpty = function() return {added = {}, removed = {}, updated = {}} end, isEmpty = function(patch) return next(patch.added) == nil and next(patch.removed) == nil and next(patch.updated) == nil end},
	PatchTree = {build = noop, updateMetadata = noop},
	Timer = {start = noop, stop = noop},
	Fmt = {debugify = noop},
	InstanceMap = {new = function() return {fromInstances = {}, fromIds = {}, stop = noop} end},
	ChangeBatcher = {new = function() return {stop = noop} end},
	Reconciler = {new = function() return {
		hydrate = noop,
		diff = function() return true, {added = {}, removed = {}, updated = if emptyDiff then {} else {{id = "root", changedName = reconcileName}}} end,
		applyPatch = function() world.Name = reconcileName; return {added = {}, removed = {}, updated = {}} end,
	} end},
	Http = {get = function(url)
		if httpFailure == "throw" then error("synchronous HTTP setup error") end
		table.insert(httpRequests, url)
		return if httpFailure == "reject" then Promise.reject("HTTP denied") else Promise.resolve({code = 204})
	end},
}
local environment = setmetatable({game = world, workspace = {GetAttribute = function() return playtestUrl end, SetAttribute = noop}, script = scriptNode,
	require = function(ref) return modules[ref.name] or {} end,
	Enum = {WebStreamClientState = {Connecting = "Connecting", Open = "Open", Error = "Error", Closed = "Closed"}},
	task = tasks, os = {clock = function() return now end, time = function() return 123 end},
	DateTime = {now = function() return {UnixTimestamp = 123, FormatLocalTime = function() return "12:00" end} end},
	Instance = {new = function() return {Event = signal(), Destroy = noop} end},
}, {__index = getfenv()})
local function loadModule(source, name)
	local chunk, err = loadstring(source, name); assert(chunk, err); setfenv(chunk, environment); return chunk()
end
local Session = loadModule([====[__SESSION_SOURCE__]====], "ServeSession")
modules.ServeSession = Session
local apiConnect = Promise.new()
local apiRead = Promise.new()
local currentApi
local reads = 0
local connects = 0
modules.ApiContext = {new = function(url)
	connects += 1
	currentApi = {__baseUrl = url,
		connect = function() return apiConnect end,
		read = function() reads += 1; return apiRead end,
		setMessageCursor = noop,
		connectWebSocket = function(self) self.__wsClient = {ConnectionState = "Connecting"}; return Promise.new() end,
		disconnect = noop,
	}
	return currentApi
end}
loadModule([====[__APP_SOURCE__]====], "App")
appClass.__index = appClass
local function app()
	local self = setmetatable({state = {}, props = {}}, appClass)
	self.setState = function(_, changes)
		if type(changes) == "function" then changes = changes(self.state) end
		for key, value in changes do self.state[key] = value end
	end
	self.claimSyncLock = function() return true end
	self.releaseSyncLock = noop
	self.startSyncReminderPolling = noop
	self.stopSyncReminderPolling = noop
	self.checkSyncReminder = noop
	self:init()
	return self
end
local callbackUrl = "http://127.0.0.1:50000/ready/" .. string.rep("a", 64) .. "?projectName=Game%40worktree&sessionId=launch"
local function marker(attributes, archivable, className)
	local values = attributes or {Host = "127.0.0.1", Port = "34872", SessionId = "launch", ProjectName = "Game@worktree", ReadyUrl = callbackUrl}
	local result = {Name = "ROJO_OPEN_42", Archivable = archivable or false, destroyed = false,
		IsA = function(_, class) return class == (className or "Configuration") end,
		GetAttribute = function(_, key) return values[key] end,
	}
	result.Destroy = function() result.destroyed = true end
	return result
end
local function reset()
	apiConnect = Promise.new(); apiRead = Promise.new(); httpRequests = {}; reads = 0; connects = 0; httpFailure = nil; existing = nil; edit = true; sleepers = {}; now = 0
	world.ChildAdded = signal(); world.Name = "Untitled"
	playtestUrl = nil; settings.autoConnectPlaytestServer = false
	emptyDiff = false; settings.confirmationBehavior = "Initial"
	settings.priorEndpoints = {["0"] = {host = "old", port = "9", projectName = "Foreign"}}
end
local function server(projectName, sessionId)
	reconcileName = projectName or "Game@worktree"
	apiConnect:resolve({projectName = projectName or "Game@worktree", sessionId = sessionId or "launch", rootInstanceId = "root"})
end
local function initialSync() apiRead:resolve({messageCursor = 1, instances = {}}) end
local function openStream() currentApi.__wsClient.ConnectionState = "Open"; advance(0.1) end

-- Existing-marker connection runs the real initial-sync and stream-readiness code.
reset(); existing = marker(); local first = app()
assert(existing.destroyed and connects == 1 and currentApi.__baseUrl == "http://127.0.0.1:34872")
server(); assert(reads == 1 and #httpRequests == 0)
initialSync(); assert(first.serveSession:getStatus() == Session.Status.Connected and #httpRequests == 0)
advance(1); assert(#httpRequests == 0, "Connecting is not ready")
openStream(); assert(#httpRequests == 1 and httpRequests[1] == callbackUrl and world.Name == "Game@worktree")
advance(1); assert(#httpRequests == 1, "acknowledge only once")
local duplicate = marker(); world.ChildAdded:Fire(duplicate)
assert(duplicate.destroyed and connects == 1, "an active session consumes duplicate markers")
first:willUnmount()
local unmounted = marker(); world.ChildAdded:Fire(unmounted)
assert(not unmounted.destroyed and connects == 1, "unmount disconnects the marker listener")

-- No marker bypasses saved-endpoint automatic reconnect despite its enabled setting.
reset(); local manual = app(); server("Foreign", "old"); advance(1)
assert(connects == 0 and reads == 0 and #httpRequests == 0)
local delayed = marker(); world.ChildAdded:Fire(delayed); assert(delayed.destroyed and connects == 1)
assert(reads == 0 and manual.serveSession == nil, "stale persisted response must not sync")
manual:endSession(); assert(manual.forgeMarker == nil)

-- Manual Connect keeps stock project selection and sends no launch acknowledgement.
reset(); settings.confirmationBehavior = "Never"; local clicked = app(); clicked:startSession()
server("Manually chosen", "manual-session"); initialSync(); openStream()
assert(clicked.serveSession:getStatus() == Session.Status.Connected and world.Name == "Manually chosen" and #httpRequests == 0)
clicked:endSession()

-- Playtest connections use the stock workspace endpoint without a launch marker.
reset(); edit = false; settings.autoConnectPlaytestServer = true; playtestUrl = "127.0.0.1:45678"
local playtest = app(); assert(connects == 1 and currentApi.__baseUrl == "http://127.0.0.1:45678")
server("Playtest", "playtest-session"); initialSync(); openStream()
assert(playtest.serveSession:getStatus() == Session.Status.Connected and #httpRequests == 0)
playtest:endSession()

for _, identity in {{"Foreign", "launch"}, {"Game@worktree", "foreign"}} do
	reset(); emptyDiff = true; local instance = app(); world.ChildAdded:Fire(marker()); server(identity[1], identity[2]); advance(1)
	assert(reads == 0 and #httpRequests == 0 and instance.serveSession == nil, "reject identity before initial sync")
	instance:willUnmount()
end
for _, mode in {"throw", "reject"} do
	reset(); local instance = app(); world.ChildAdded:Fire(marker()); server(); initialSync(); httpFailure = mode; openStream()
	assert(instance.serveSession:getStatus() == Session.Status.Connected, "acknowledgement errors cannot stop synchronization")
	instance:willUnmount()
end
for _, state in {"Error", "Closed"} do
	reset(); local instance = app(); world.ChildAdded:Fire(marker()); server(); initialSync(); currentApi.__wsClient.ConnectionState = state; advance(1)
	assert(#httpRequests == 0); instance:willUnmount()
end
for _, when in {"connect", "initial", "stream"} do
	reset(); local instance = app(); world.ChildAdded:Fire(marker())
	if when ~= "connect" then server() end
	if when == "stream" then initialSync() end
	instance:endSession(); server(); initialSync(); advance(1)
	assert(instance.serveSession == nil and instance.forgeMarker == nil and #httpRequests == 0)
	instance:willUnmount()
end
reset(); local failed = app(); world.ChildAdded:Fire(marker()); server(); apiRead:reject("initial sync failed"); advance(1)
assert(failed.serveSession == nil and #httpRequests == 0); failed:willUnmount()
reset(); local bounded = app(); world.ChildAdded:Fire(marker()); server(); initialSync(); advance(181); openStream()
assert(#httpRequests == 0); bounded:willUnmount()

for _, ignored in {marker(nil, true), marker(nil, false, "Folder"), marker({Host = "foreign", Port = "1", SessionId = "s", ProjectName = "p"}), marker({Host = "127.0.0.1", Port = 12, SessionId = "s", ProjectName = "p"}), marker({Host = "127.0.0.1", Port = "99999", SessionId = "s", ProjectName = "p"}), marker({Host = "127.0.0.1", Port = "12", SessionId = "s", ProjectName = "p", ReadyUrl = "https://foreign/ack"})} do
	reset(); local instance = app(); world.ChildAdded:Fire(ignored)
	assert(ignored.destroyed and connects == 0); instance:willUnmount()
end
reset(); edit = false; local playing = app(); local ignored = marker(); world.ChildAdded:Fire(ignored)
assert(ignored.destroyed and connects == 0); playing:willUnmount()
reset(); local currentUser = app(); local foreignUser = marker(); foreignUser.Name = "ROJO_OPEN_99"; world.ChildAdded:Fire(foreignUser)
assert(not foreignUser.destroyed and connects == 0); currentUser:willUnmount()
print("PASS: full shipped App/ServeSession marker, identity, initial sync, stream, cancellation, and HTTP isolation")
