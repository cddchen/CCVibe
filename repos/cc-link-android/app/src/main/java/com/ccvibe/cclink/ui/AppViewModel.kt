package com.ccvibe.cclink.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.ccvibe.cclink.CCLinkApplication
import com.ccvibe.cclink.data.ActiveSession
import com.ccvibe.cclink.data.ChatMessage
import com.ccvibe.cclink.data.ChatState
import com.ccvibe.cclink.data.ConnectionConfig
import com.ccvibe.cclink.data.ConnectionState
import com.ccvibe.cclink.data.Effort
import com.ccvibe.cclink.data.HistorySession
import com.ccvibe.cclink.data.MessageBlock
import com.ccvibe.cclink.data.MessageParser
import com.ccvibe.cclink.data.MessageRole
import com.ccvibe.cclink.data.ModelOption
import com.ccvibe.cclink.data.PermissionMode
import com.ccvibe.cclink.data.PermissionRequest
import com.ccvibe.cclink.data.RpcNotification
import com.ccvibe.cclink.data.SessionGroup
import com.ccvibe.cclink.data.ToolResult
import com.ccvibe.cclink.data.ToolStatus
import com.ccvibe.cclink.data.Workspace
import com.ccvibe.cclink.data.obj
import com.ccvibe.cclink.data.string
import com.ccvibe.cclink.network.ConnectionAddress
import java.util.UUID
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

sealed interface AppScreen {
    data object Loading : AppScreen
    data object Login : AppScreen
    data object Sessions : AppScreen
    data object Chat : AppScreen
}

enum class ThemeMode { SYSTEM, LIGHT, DARK }

data class LoginUiState(
    val host: String = "",
    val port: String = "4733",
    val useTls: Boolean = false,
    val token: String = "",
    val connecting: Boolean = false,
    val error: String? = null,
)

data class SessionsUiState(
    val groups: List<SessionGroup> = emptyList(),
    val active: Map<String, ActiveSession> = emptyMap(),
    val expanded: Set<String> = emptySet(),
    val loading: Boolean = false,
    val refreshing: Boolean = false,
    val error: String? = null,
)

class AppViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as CCLinkApplication
    private val client = app.daemonClient
    private val store = app.connectionStore
    private val json = Json { ignoreUnknownKeys = true }

    private val _screen = MutableStateFlow<AppScreen>(AppScreen.Loading)
    val screen: StateFlow<AppScreen> = _screen.asStateFlow()

    private val _connection = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    private val _login = MutableStateFlow(LoginUiState())
    val login: StateFlow<LoginUiState> = _login.asStateFlow()

    private val _sessions = MutableStateFlow(
        SessionsUiState(expanded = store.readExpandedDirectories()),
    )
    val sessions: StateFlow<SessionsUiState> = _sessions.asStateFlow()

    private val _chat = MutableStateFlow(ChatState())
    val chat: StateFlow<ChatState> = _chat.asStateFlow()

    private val _models = MutableStateFlow(defaultModels())
    val models: StateFlow<List<ModelOption>> = _models.asStateFlow()

    private val _theme = MutableStateFlow(
        when (store.readTheme()) {
            "light" -> ThemeMode.LIGHT
            "dark" -> ThemeMode.DARK
            else -> ThemeMode.SYSTEM
        },
    )
    val theme: StateFlow<ThemeMode> = _theme.asStateFlow()

    private val sessionAliases = mutableSetOf<String>()
    private var sessionPollingJob: Job? = null
    private var turnStartedAt: Long? = null
    private var refreshAfterTurn = false
    private var interruptRequested = false

    init {
        viewModelScope.launch { client.state.collect { _connection.value = it } }
        viewModelScope.launch { client.notifications.collect(::handleNotification) }
        viewModelScope.launch {
            client.reconnected.collect {
                when (_screen.value) {
                    AppScreen.Sessions -> refreshSessions()
                    AppScreen.Chat -> reloadCurrentChat()
                    else -> Unit
                }
            }
        }
        val saved = store.readConnection()
        if (saved == null) {
            _screen.value = AppScreen.Login
        } else {
            _login.value = LoginUiState(
                host = saved.host,
                port = saved.port.toString(),
                useTls = saved.useTls,
                token = saved.token,
                connecting = true,
            )
            viewModelScope.launch { connect(saved, save = false, auto = true) }
        }
    }

    fun updateLoginHost(value: String) { _login.value = _login.value.copy(host = value, error = null) }
    fun updateLoginPort(value: String) { _login.value = _login.value.copy(port = value.filter(Char::isDigit), error = null) }
    fun updateLoginTls(value: Boolean) { _login.value = _login.value.copy(useTls = value, error = null) }
    fun updateLoginToken(value: String) { _login.value = _login.value.copy(token = value, error = null) }

    fun submitLogin() {
        val form = _login.value
        val config = runCatching {
            ConnectionAddress.resolve(form.host, form.port, form.useTls, form.token)
        }.getOrElse {
            _login.value = form.copy(error = it.message ?: "连接信息不合法")
            return
        }
        viewModelScope.launch { connect(config, save = true, auto = false) }
    }

    private suspend fun connect(config: ConnectionConfig, save: Boolean, auto: Boolean) {
        _login.value = _login.value.copy(connecting = true, error = null)
        if (!auto) _screen.value = AppScreen.Login
        try {
            client.connect(config)
            if (save) store.saveConnection(config)
            _login.value = LoginUiState(config.host, config.port.toString(), config.useTls, config.token)
            loadSettings()
            _screen.value = AppScreen.Sessions
            refreshSessions()
            startSessionPolling()
        } catch (error: Throwable) {
            _login.value = _login.value.copy(connecting = false, error = error.message ?: "连接失败")
            _screen.value = AppScreen.Login
        }
    }

    fun disconnect() {
        sessionPollingJob?.cancel()
        client.disconnect()
        _screen.value = AppScreen.Login
        _login.value = _login.value.copy(connecting = false)
    }

    fun refreshSessions(userInitiated: Boolean = false) {
        viewModelScope.launch {
            val old = _sessions.value
            _sessions.value = old.copy(
                loading = old.groups.isEmpty(),
                refreshing = userInitiated,
                error = null,
            )
            try {
                val (groups, active) = coroutineScope {
                    val groupsTask = async { loadSessionGroups() }
                    val activeTask = async { loadActiveSessions() }
                    groupsTask.await() to activeTask.await()
                }
                val expanded = _sessions.value.expanded.toMutableSet()
                if (expanded.isEmpty()) groups.forEach { expanded += it.workspace.path }
                _sessions.value = _sessions.value.copy(
                    groups = groups,
                    active = active.associateBy { it.sessionId },
                    expanded = expanded,
                    loading = false,
                    refreshing = false,
                )
                store.saveExpandedDirectories(expanded)
            } catch (error: Throwable) {
                _sessions.value = _sessions.value.copy(
                    loading = false,
                    refreshing = false,
                    error = error.message ?: "会话列表加载失败",
                )
            }
        }
    }

    fun toggleDirectory(path: String) {
        val next = _sessions.value.expanded.toMutableSet()
        if (!next.add(path)) next.remove(path)
        _sessions.value = _sessions.value.copy(expanded = next)
        store.saveExpandedDirectories(next)
    }

    fun addWorkspace(path: String, onComplete: (String?) -> Unit) {
        if (path.trim().isEmpty()) {
            onComplete("请输入 daemon 主机上的绝对路径")
            return
        }
        viewModelScope.launch {
            try {
                client.call("workspace.add", buildJsonObject { put("path", path.trim()) })
                refreshSessions(userInitiated = true)
                onComplete(null)
            } catch (error: Throwable) {
                onComplete(error.message ?: "添加工作目录失败")
            }
        }
    }

    fun openChat(workspacePath: String, sessionId: String?) {
        sessionAliases.clear()
        interruptRequested = false
        sessionId?.let(sessionAliases::add)
        _chat.value = ChatState(
            workspacePath = workspacePath,
            historySessionId = sessionId,
            liveSessionId = sessionId,
            title = sessionId?.let { "会话 ${it.take(8)}…" } ?: "新会话",
            loading = true,
            selectedModel = _models.value.firstOrNull()?.id ?: "claude-sonnet-4-6",
            effort = _chat.value.effort,
            permissionMode = _chat.value.permissionMode,
        )
        _screen.value = AppScreen.Chat
        viewModelScope.launch { prepareChat() }
    }

    fun returnToSessions() {
        val sid = _chat.value.liveSessionId
        if (sid != null) viewModelScope.launch { runCatching { client.call("session.detach", params("sessionId", sid)) } }
        _screen.value = AppScreen.Sessions
        refreshSessions()
    }

    fun trustWorkspace(path: String) {
        viewModelScope.launch {
            try {
                client.call("workspace.add", params("path", path))
                _chat.value = _chat.value.copy(trusted = true, trustPath = null, trustParent = null, loading = true)
                hydrateChat()
            } catch (error: Throwable) {
                _chat.value = _chat.value.copy(error = error.message ?: "信任目录失败")
            }
        }
    }

    fun updateDraft(value: String) { _chat.value = _chat.value.copy(draft = value) }

    fun sendMessage() {
        val state = _chat.value
        val text = state.draft.trim()
        if (text.isEmpty() || state.busy || !state.trusted || connection.value !is ConnectionState.Connected) return
        interruptRequested = false
        val userMessage = ChatMessage(UUID.randomUUID().toString(), MessageRole.USER, userText = text)
        val assistant = ChatMessage(UUID.randomUUID().toString(), MessageRole.ASSISTANT, streaming = true)
        _chat.value = state.copy(
            draft = "",
            messages = state.messages + userMessage + assistant,
            busy = true,
            runStatus = "运行中",
            error = null,
        )
        turnStartedAt = System.currentTimeMillis()
        viewModelScope.launch {
            try {
                val sid = ensureSession()
                client.call(
                    "session.sendMessage",
                    buildJsonObject {
                        put("sessionId", sid)
                        put("content", text)
                    },
                )
            } catch (error: Throwable) {
                finishTurn(error.message ?: "发送失败")
            }
        }
    }

    fun stop() {
        val sid = _chat.value.liveSessionId ?: return
        interruptRequested = true
        viewModelScope.launch {
            try {
                client.call("session.interrupt", params("sessionId", sid))
                finishTurn(null, "已停止")
            } catch (error: Throwable) {
                interruptRequested = false
                _chat.value = _chat.value.copy(error = error.message ?: "停止失败")
            }
        }
    }

    fun selectModel(model: String) {
        if (_chat.value.busy) return
        _chat.value = _chat.value.copy(selectedModel = model)
        restartHistoricalSessionIfNeeded(model = model)
    }

    fun selectEffort(effort: Effort) {
        if (_chat.value.busy) return
        _chat.value = _chat.value.copy(effort = effort)
        restartHistoricalSessionIfNeeded(effort = effort)
    }

    fun selectPermissionMode(mode: PermissionMode) {
        if (_chat.value.busy) return
        _chat.value = _chat.value.copy(permissionMode = mode)
        val sid = _chat.value.liveSessionId ?: return
        viewModelScope.launch {
            runCatching {
                client.call(
                    "session.setPermissionMode",
                    buildJsonObject { put("sessionId", sid); put("mode", mode.rpcValue) },
                )
            }.onFailure { _chat.value = _chat.value.copy(error = it.message) }
        }
    }

    fun respondPermission(allow: Boolean, updatedInput: String, denyMessage: String) {
        val request = _chat.value.pendingPermission ?: return
        viewModelScope.launch {
            try {
                val parsedInput = if (allow) json.parseToJsonElement(updatedInput).jsonObject else null
                client.call(
                    "permission.respond",
                    buildJsonObject {
                        put("sessionId", request.sessionId)
                        put("requestId", request.requestId)
                        put("behavior", if (allow) "allow" else "deny")
                        if (parsedInput != null) put("updatedInput", parsedInput)
                        if (!allow) put("message", denyMessage.ifBlank { "用户拒绝" })
                    },
                )
                _chat.value = _chat.value.copy(pendingPermission = null)
            } catch (error: Throwable) {
                _chat.value = _chat.value.copy(error = error.message ?: "权限响应失败")
            }
        }
    }

    fun respondAskQuestion(answers: JsonObject?) {
        val request = _chat.value.pendingPermission ?: return
        viewModelScope.launch {
            try {
                client.call(
                    "permission.respond",
                    buildJsonObject {
                        put("sessionId", request.sessionId)
                        put("requestId", request.requestId)
                        put("behavior", if (answers == null) "deny" else "allow")
                        if (answers != null) {
                            put("updatedInput", JsonObject(request.input + ("answers" to answers)))
                        } else {
                            put("message", "用户取消了问题")
                        }
                    },
                )
                _chat.value = _chat.value.copy(pendingPermission = null)
            } catch (error: Throwable) {
                _chat.value = _chat.value.copy(error = error.message ?: "提交答案失败")
            }
        }
    }

    fun retryCurrentChat() {
        viewModelScope.launch { reloadCurrentChat() }
    }

    fun retryLastMessage() {
        if (_chat.value.busy) return
        val text = _chat.value.messages.asReversed().firstOrNull { it.role == MessageRole.USER }?.userText ?: return
        _chat.value = _chat.value.copy(draft = text, error = null)
        sendMessage()
    }

    fun setTheme(mode: ThemeMode) {
        _theme.value = mode
        store.saveTheme(mode.name.lowercase())
    }

    fun onForeground() {
        if (_screen.value == AppScreen.Chat && connection.value is ConnectionState.Connected) {
            viewModelScope.launch { reloadCurrentChat() }
        } else if (_screen.value == AppScreen.Sessions) {
            refreshSessions()
        }
    }

    private suspend fun prepareChat() {
        try {
            val trust = client.call("workspace.checkTrust", params("path", _chat.value.workspacePath)).jsonObject
            val trusted = (trust["trusted"] as? JsonPrimitive)?.content == "true"
            if (!trusted) {
                _chat.value = _chat.value.copy(
                    loading = false,
                    trusted = false,
                    trustPath = trust.string("path") ?: _chat.value.workspacePath,
                    trustParent = trust.string("parent"),
                )
                return
            }
            _chat.value = _chat.value.copy(trusted = true)
            hydrateChat()
        } catch (error: Throwable) {
            _chat.value = _chat.value.copy(loading = false, error = error.message ?: "工作目录校验失败")
        }
    }

    private suspend fun hydrateChat() {
        val state = _chat.value
        val historyId = state.historySessionId
        if (historyId == null) {
            _chat.value = state.copy(loading = false, messages = emptyList(), toolResults = emptyMap())
            return
        }
        try {
            val history = client.call(
                "history.loadSession",
                buildJsonObject { put("sessionId", historyId); put("workspacePath", state.workspacePath) },
            ).jsonObject
            val parsed = MessageParser.parseHistory(history["messages"]?.jsonArray ?: JsonArray(emptyList()))
            val lastModel = parsed.messages.asReversed().firstOrNull { it.role == MessageRole.ASSISTANT }?.model
            val attached = client.call("session.attachIfLive", params("sessionId", historyId)).jsonObject
            val isAttached = (attached["attached"] as? JsonPrimitive)?.content == "true"
            val liveId = attached.string("sessionId") ?: historyId
            sessionAliases += historyId
            if (isAttached) sessionAliases += liveId
            _chat.value = _chat.value.copy(
                loading = false,
                messages = parsed.messages,
                toolResults = parsed.toolResults,
                liveSessionId = if (isAttached) liveId else historyId,
                selectedModel = lastModel ?: _chat.value.selectedModel,
                busy = isAttached && attached.string("status") in setOf("running", "starting"),
                runStatus = attached.string("status"),
                error = null,
            )
        } catch (error: Throwable) {
            _chat.value = _chat.value.copy(loading = false, error = error.message ?: "历史会话加载失败")
        }
    }

    private suspend fun reloadCurrentChat() {
        if (_screen.value != AppScreen.Chat || !_chat.value.trusted) return
        _chat.value = _chat.value.copy(loading = _chat.value.messages.isEmpty())
        hydrateChat()
    }

    private suspend fun ensureSession(): String {
        val state = _chat.value
        val existing = state.liveSessionId ?: state.historySessionId
        if (existing != null) {
            try {
                client.call("session.attach", params("sessionId", existing))
                sessionAliases += existing
                return existing
            } catch (_: Throwable) {
                state.historySessionId?.let { return resumeSession(it) }
                error("活跃会话已失效")
            }
        }
        val result = client.call(
            "session.create",
            buildJsonObject {
                put("cwd", state.workspacePath)
                put("model", state.selectedModel)
                put("effort", state.effort.rpcValue)
                put("permissionMode", state.permissionMode.rpcValue)
                put("settingSources", buildJsonArray { add(JsonPrimitive("user")); add(JsonPrimitive("project")) })
            },
        ).jsonObject
        val sessionId = result.string("sessionId") ?: error("daemon 未返回 sessionId")
        sessionAliases += sessionId
        _chat.value = _chat.value.copy(liveSessionId = sessionId)
        refreshAfterTurn = true
        client.call("session.attach", params("sessionId", sessionId))
        return sessionId
    }

    private suspend fun resumeSession(
        historyId: String,
        model: String = _chat.value.selectedModel,
        effort: Effort = _chat.value.effort,
    ): String {
        val state = _chat.value
        val result = client.call(
            "session.resume",
            buildJsonObject {
                put("sessionId", historyId)
                put("cwd", state.workspacePath)
                put("model", model)
                put("effort", effort.rpcValue)
                put("permissionMode", state.permissionMode.rpcValue)
            },
        ).jsonObject
        val liveId = result.string("sessionId") ?: error("恢复会话失败")
        sessionAliases += historyId
        sessionAliases += liveId
        _chat.value = _chat.value.copy(liveSessionId = liveId)
        client.call("session.attach", params("sessionId", liveId))
        return liveId
    }

    private fun restartHistoricalSessionIfNeeded(model: String? = null, effort: Effort? = null) {
        val historyId = _chat.value.historySessionId ?: return
        viewModelScope.launch {
            runCatching {
                resumeSession(historyId, model ?: _chat.value.selectedModel, effort ?: _chat.value.effort)
            }.onFailure { _chat.value = _chat.value.copy(error = it.message ?: "切换设置失败") }
        }
    }

    private suspend fun loadSettings() {
        runCatching {
            val settings = client.call("settings.get").jsonObject.obj("settings") ?: return
            val configured = settings.obj("models")
            _models.value = listOf(
                ModelOption(configured?.string("sonnet") ?: "claude-sonnet-4-6", "Sonnet"),
                ModelOption(configured?.string("opus") ?: "claude-opus-4-7", "Opus"),
                ModelOption(configured?.string("haiku") ?: "claude-haiku-4-5-20251001", "Haiku"),
            )
            _chat.value = _chat.value.copy(
                selectedModel = settings.obj("models")?.string("default") ?: _models.value.first().id,
                effort = Effort.fromRpc(settings.string("effortLevel")),
                permissionMode = PermissionMode.fromRpc(settings.obj("permissions")?.string("defaultMode")),
            )
        }
    }

    private suspend fun loadSessionGroups(): List<SessionGroup> {
        val projectsResult = client.call("history.listAllLocal").jsonObject
        val workspacesResult = client.call("workspace.list").jsonObject
        val sessionsByPath = mutableMapOf<String, List<HistorySession>>()
        val workspaces = linkedMapOf<String, Workspace>()

        (projectsResult["projects"] as? JsonArray).orEmpty().forEach { element ->
            val project = element.jsonObject
            val path = project.string("workspacePath") ?: return@forEach
            val sessions = parseSessions(project["sessions"] as? JsonArray)
            sessionsByPath[path] = sessions
            workspaces[path] = Workspace(path, path, sessions.firstOrNull()?.lastTimestamp ?: "")
        }

        (workspacesResult["workspaces"] as? JsonArray).orEmpty().forEach { element ->
            val workspace = element.jsonObject
            val path = workspace.string("path") ?: return@forEach
            workspaces[path] = Workspace(
                id = workspace.string("id") ?: path,
                path = path,
                createdAt = workspace.string("createdAt") ?: "",
            )
            if (sessionsByPath[path] == null) {
                val sessions = runCatching {
                    parseSessions(client.call("history.listSessions", params("workspacePath", path)).jsonObject["sessions"] as? JsonArray)
                }.getOrDefault(emptyList())
                sessionsByPath[path] = sessions
            }
        }

        return workspaces.values.map { workspace ->
            val sessions = sessionsByPath[workspace.path].orEmpty().sortedWith(
                compareByDescending<HistorySession> { it.lastTimestamp.orEmpty() }.thenBy { it.sessionId },
            )
            SessionGroup(workspace, sessions, sessions.firstOrNull()?.lastTimestamp ?: workspace.createdAt)
        }.sortedWith(compareByDescending<SessionGroup> { it.latestAt }.thenBy { it.workspace.path })
    }

    private suspend fun loadActiveSessions(): List<ActiveSession> {
        val result = client.call("session.listActive").jsonObject
        return (result["sessions"] as? JsonArray).orEmpty().mapNotNull { element ->
            val row = element as? JsonObject ?: return@mapNotNull null
            ActiveSession(
                sessionId = row.string("sessionId") ?: return@mapNotNull null,
                cwd = row.string("cwd") ?: "",
                status = row.string("status") ?: "running",
                subscriberCount = (row["subscriberCount"] as? JsonPrimitive)?.intOrNull ?: 0,
            )
        }
    }

    private fun parseSessions(array: JsonArray?): List<HistorySession> = array.orEmpty().mapNotNull { element ->
        val row = element as? JsonObject ?: return@mapNotNull null
        HistorySession(
            sessionId = row.string("sessionId") ?: return@mapNotNull null,
            messageCount = (row["messageCount"] as? JsonPrimitive)?.intOrNull ?: 0,
            lastTimestamp = row.string("lastTimestamp"),
            title = row.string("customName") ?: row.string("title") ?: row.string("summary"),
        )
    }

    private fun startSessionPolling() {
        sessionPollingJob?.cancel()
        sessionPollingJob = viewModelScope.launch {
            while (true) {
                delay(8_000)
                if (connection.value is ConnectionState.Connected) {
                    runCatching { loadActiveSessions() }.onSuccess { active ->
                        _sessions.value = _sessions.value.copy(active = active.associateBy { it.sessionId })
                    }
                }
            }
        }
    }

    private suspend fun handleNotification(notification: RpcNotification) {
        when (notification.method) {
            "session/event" -> handleSessionEvent(notification.params)
            "session/status" -> handleSessionStatus(notification.params)
            "permission/request" -> handlePermission(notification.params)
        }
    }

    private fun handleSessionEvent(params: JsonObject) {
        if (!matchesCurrentSession(params)) return
        val event = params.obj("message") ?: return
        when (event.string("type")) {
            "system" -> if (event.string("subtype") == "init") {
                val sdkId = event.string("session_id")
                val model = event.string("model")
                params.string("runtimeId")?.let(sessionAliases::add)
                params.string("sessionId")?.let(sessionAliases::add)
                sdkId?.let(sessionAliases::add)
                _chat.value = _chat.value.copy(
                    liveSessionId = sdkId ?: _chat.value.liveSessionId,
                    historySessionId = sdkId ?: _chat.value.historySessionId,
                    title = if (_chat.value.historySessionId == null && sdkId != null) "会话 ${sdkId.take(8)}…" else _chat.value.title,
                    selectedModel = model ?: _chat.value.selectedModel,
                    runStatus = "运行中",
                )
            }
            "stream_event" -> updateStreamingMessage { message ->
                message.copy(blocks = MessageParser.applyStreamDelta(message.blocks, event), streaming = true)
            }
            "assistant" -> {
                val (blocks, model) = MessageParser.parseAssistantSnapshot(event)
                if (blocks.isNotEmpty()) {
                    updateStreamingMessage { message -> message.copy(blocks = blocks, model = model ?: message.model, streaming = true) }
                    val nextTools = _chat.value.toolResults.toMutableMap()
                    MessageParser.toolIds(blocks).forEach { nextTools.putIfAbsent(it, ToolResult(ToolStatus.RUNNING)) }
                    _chat.value = _chat.value.copy(toolResults = nextTools)
                }
            }
            "user" -> _chat.value = _chat.value.copy(
                toolResults = MessageParser.updateToolResultsFromEvent(event, _chat.value.toolResults),
            )
            "result" -> {
                val error = event.string("subtype")?.takeIf { it == "error" || it == "error_during_execution" }
                    ?.let { event["errors"]?.toString() ?: it }
                val wasInterrupted = interruptRequested
                val elapsed = turnStartedAt?.let { (System.currentTimeMillis() - it) / 1000 }
                updateStreamingMessage { message ->
                    message.copy(
                        streaming = false,
                        metrics = MessageParser.resultMetrics(event, elapsed) ?: message.metrics,
                        error = if (wasInterrupted) null else error,
                    )
                }
                _chat.value = _chat.value.copy(
                    busy = false,
                    runStatus = if (wasInterrupted) "已停止" else if (error == null) "已完成" else "失败",
                    error = if (wasInterrupted) null else error,
                )
                turnStartedAt = null
                if (refreshAfterTurn) {
                    refreshAfterTurn = false
                    refreshSessions()
                }
            }
        }
    }

    private fun handleSessionStatus(params: JsonObject) {
        if (!matchesCurrentSession(params)) return
        val status = params.string("status") ?: return
        val terminal = status in setOf("completed", "error", "interrupted")
        val wasInterrupted = interruptRequested || status == "interrupted"
        if (terminal) updateStreamingMessage { it.copy(streaming = false) }
        _chat.value = _chat.value.copy(
            busy = !terminal && status in setOf("running", "starting"),
            runStatus = if (wasInterrupted) "已停止" else status,
            error = if (wasInterrupted) null else params.string("error") ?: _chat.value.error,
        )
    }

    private fun handlePermission(params: JsonObject) {
        val sessionId = params.string("sessionId") ?: return
        if (sessionId !in sessionAliases && sessionId != _chat.value.liveSessionId && sessionId != _chat.value.historySessionId) return
        val request = PermissionRequest(
            sessionId = sessionId,
            requestId = params["requestId"] ?: return,
            toolName = params.string("toolName") ?: "Tool",
            input = params.obj("input") ?: JsonObject(emptyMap()),
        )
        _chat.value = _chat.value.copy(pendingPermission = request)
    }

    private fun matchesCurrentSession(params: JsonObject): Boolean {
        if (_screen.value != AppScreen.Chat) return false
        val ids = listOfNotNull(params.string("sessionId"), params.string("runtimeId"))
        return ids.any {
            it in sessionAliases || it == _chat.value.liveSessionId || it == _chat.value.historySessionId
        }
    }

    private fun updateStreamingMessage(transform: (ChatMessage) -> ChatMessage) {
        val messages = _chat.value.messages.toMutableList()
        val index = messages.indexOfLast { it.role == MessageRole.ASSISTANT && it.streaming }
        if (index >= 0) {
            messages[index] = transform(messages[index])
        } else {
            messages += transform(ChatMessage(UUID.randomUUID().toString(), MessageRole.ASSISTANT, streaming = true))
        }
        _chat.value = _chat.value.copy(messages = messages)
    }

    private fun finishTurn(error: String?, status: String = "失败") {
        updateStreamingMessage { it.copy(streaming = false, error = error) }
        _chat.value = _chat.value.copy(busy = false, runStatus = status, error = error)
        turnStartedAt = null
    }

    private fun params(key: String, value: String): JsonObject = buildJsonObject { put(key, value) }

    private fun defaultModels() = listOf(
        ModelOption("claude-sonnet-4-6", "Sonnet"),
        ModelOption("claude-opus-4-7", "Opus"),
        ModelOption("claude-haiku-4-5-20251001", "Haiku"),
    )
}
