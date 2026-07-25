package com.ccvibe.cclink.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.ccvibe.cclink.CCLinkApplication
import com.ccvibe.cclink.data.ActiveSession
import com.ccvibe.cclink.data.ChatState
import com.ccvibe.cclink.data.ConnectionConfig
import com.ccvibe.cclink.data.ConnectionState
import com.ccvibe.cclink.data.Effort
import com.ccvibe.cclink.data.HistorySession
import com.ccvibe.cclink.data.MessageParser
import com.ccvibe.cclink.data.MessageRole
import com.ccvibe.cclink.data.ModelOption
import com.ccvibe.cclink.data.PendingTurnFeedback
import com.ccvibe.cclink.data.PermissionMode
import com.ccvibe.cclink.data.PermissionQueue
import com.ccvibe.cclink.data.PermissionRequest
import com.ccvibe.cclink.data.RpcNotification
import com.ccvibe.cclink.data.SessionGroup
import com.ccvibe.cclink.data.Workspace
import com.ccvibe.cclink.data.boolean
import com.ccvibe.cclink.data.long
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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
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
    private val _sessions = MutableStateFlow(SessionsUiState(expanded = store.readExpandedDirectories()))
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

    private val conversationAliases = mutableSetOf<String>()
    private var domainMessages: List<JsonObject> = emptyList()
    private var pendingTurn: PendingTurnFeedback? = null
    private var pendingPermissions: List<PermissionRequest> = emptyList()
    private var sessionPollingJob: Job? = null
    private var lastSequence = 0L
    private var sequenceRuntimeId: String? = null
    private var hydratedKey: String? = null
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
            _login.value = LoginUiState(saved.host, saved.port.toString(), saved.useTls, saved.token, connecting = true)
            viewModelScope.launch { connect(saved, save = false, auto = true) }
        }
    }

    fun updateLoginHost(value: String) { _login.value = _login.value.copy(host = value, error = null) }
    fun updateLoginPort(value: String) { _login.value = _login.value.copy(port = value.filter(Char::isDigit), error = null) }
    fun updateLoginTls(value: Boolean) { _login.value = _login.value.copy(useTls = value, error = null) }
    fun updateLoginToken(value: String) { _login.value = _login.value.copy(token = value, error = null) }

    fun submitLogin() {
        val form = _login.value
        val config = runCatching { ConnectionAddress.resolve(form.host, form.port, form.useTls, form.token) }.getOrElse {
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
            _sessions.value = old.copy(loading = old.groups.isEmpty(), refreshing = userInitiated, error = null)
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
                    active = activeMap(active),
                    expanded = expanded,
                    loading = false,
                    refreshing = false,
                )
                store.saveExpandedDirectories(expanded)
            } catch (error: Throwable) {
                _sessions.value = _sessions.value.copy(loading = false, refreshing = false, error = error.message ?: "会话列表加载失败")
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
        if (path.trim().isEmpty()) { onComplete("请输入 daemon 主机上的绝对路径"); return }
        viewModelScope.launch {
            runCatching { client.call("workspace.add", params("path", path.trim())) }
                .onSuccess { refreshSessions(userInitiated = true); onComplete(null) }
                .onFailure { onComplete(it.message ?: "添加工作目录失败") }
        }
    }

    fun openChat(workspacePath: String, sessionId: String?) {
        conversationAliases.clear()
        sessionId?.let(conversationAliases::add)
        domainMessages = emptyList()
        pendingTurn = null
        pendingPermissions = emptyList()
        lastSequence = 0
        sequenceRuntimeId = null
        hydratedKey = null
        interruptRequested = false
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
        _chat.value.liveSessionId?.let { conversationId ->
            viewModelScope.launch { runCatching { client.call("conversation.detach", params("conversationId", conversationId)) } }
        }
        _screen.value = AppScreen.Sessions
        refreshSessions()
    }

    fun trustWorkspace(path: String) {
        viewModelScope.launch {
            try {
                client.call("workspace.add", params("path", path))
                _chat.value = _chat.value.copy(trusted = true, trustPath = null, trustParent = null, loading = true)
                openConversation(force = true)
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
        val clientMessageId = UUID.randomUUID().toString()
        pendingTurn = PendingTurnFeedback(clientMessageId, text)
        interruptRequested = false
        refreshAfterTurn = true
        _chat.value = state.copy(draft = "", busy = true, runStatus = "运行中", error = null)
        rebuildChat()
        viewModelScope.launch {
            try {
                val conversationId = ensureConversation()
                val receipt = client.call(
                    "conversation.send",
                    buildJsonObject {
                        put("conversationId", conversationId)
                        put("content", text)
                        put("clientMessageId", clientMessageId)
                    },
                ).jsonObject
                val turnId = receipt.string("turnId") ?: error("daemon 未返回 turnId")
                pendingTurn?.takeIf { it.clientMessageId == clientMessageId }?.let {
                    pendingTurn = it.copy(turnId = turnId)
                    rebuildChat()
                }
            } catch (error: Throwable) {
                pendingTurn = null
                _chat.value = _chat.value.copy(busy = false, runStatus = "失败", error = error.message ?: "发送失败")
                rebuildChat()
            }
        }
    }

    fun stop() {
        val conversationId = _chat.value.liveSessionId ?: return
        interruptRequested = true
        viewModelScope.launch {
            runCatching { client.call("conversation.interrupt", params("conversationId", conversationId)) }
                .onSuccess { _chat.value = _chat.value.copy(busy = false, runStatus = "已停止", error = null) }
                .onFailure { interruptRequested = false; _chat.value = _chat.value.copy(error = it.message ?: "停止失败") }
        }
    }

    fun selectModel(model: String) {
        if (_chat.value.busy) return
        _chat.value = _chat.value.copy(selectedModel = model)
        viewModelScope.launch { applyConversationSetting("conversation.setModel", "model", model) }
    }

    fun selectEffort(effort: Effort) {
        if (_chat.value.busy) return
        _chat.value = _chat.value.copy(effort = effort)
        viewModelScope.launch { applyConversationSetting("conversation.setEffort", "effort", effort.rpcValue) }
    }

    fun selectPermissionMode(mode: PermissionMode) {
        if (_chat.value.busy) return
        _chat.value = _chat.value.copy(permissionMode = mode)
        viewModelScope.launch { applyConversationSetting("conversation.setPermissionMode", "mode", mode.rpcValue) }
    }

    private suspend fun applyConversationSetting(method: String, key: String, value: String) {
        runCatching {
            val conversationId = ensureConversation()
            client.call(method, buildJsonObject { put("conversationId", conversationId); put(key, value) })
        }.onFailure { _chat.value = _chat.value.copy(error = it.message ?: "切换设置失败") }
    }

    fun respondPermission(allow: Boolean, updatedInput: String, denyMessage: String) {
        val request = _chat.value.pendingPermission ?: return
        viewModelScope.launch {
            try {
                val parsedInput = if (allow) json.parseToJsonElement(updatedInput).jsonObject else null
                client.call(
                    "permission.respond",
                    buildJsonObject {
                        put("conversationId", request.conversationId)
                        put("requestId", request.requestId)
                        put("behavior", if (allow) "allow" else "deny")
                        parsedInput?.let { put("updatedInput", it) }
                        if (!allow) put("message", denyMessage.ifBlank { "用户拒绝" })
                    },
                )
                removePendingPermission(request)
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
                        put("conversationId", request.conversationId)
                        put("requestId", request.requestId)
                        put("behavior", if (answers == null) "deny" else "allow")
                        if (answers != null) put("updatedInput", JsonObject(request.input + ("answers" to answers)))
                        else put("message", "用户取消了问题")
                    },
                )
                removePendingPermission(request)
            } catch (error: Throwable) {
                _chat.value = _chat.value.copy(error = error.message ?: "提交答案失败")
            }
        }
    }

    fun retryCurrentChat() { viewModelScope.launch { reloadCurrentChat() } }

    fun retryLastMessage() {
        if (_chat.value.busy) return
        val text = _chat.value.messages.asReversed().firstOrNull { it.role == MessageRole.USER }?.userText ?: return
        _chat.value = _chat.value.copy(draft = text, error = null)
        sendMessage()
    }

    fun setTheme(mode: ThemeMode) { _theme.value = mode; store.saveTheme(mode.name.lowercase()) }

    fun onForeground() {
        if (_screen.value == AppScreen.Chat && connection.value is ConnectionState.Connected) {
            viewModelScope.launch { reloadCurrentChat() }
        } else if (_screen.value == AppScreen.Sessions) refreshSessions()
    }

    private suspend fun prepareChat() {
        try {
            val trust = client.call("workspace.checkTrust", params("path", _chat.value.workspacePath)).jsonObject
            if (!trust.boolean("trusted")) {
                _chat.value = _chat.value.copy(
                    loading = false,
                    trusted = false,
                    trustPath = trust.string("path") ?: _chat.value.workspacePath,
                    trustParent = trust.string("parent"),
                )
                return
            }
            _chat.value = _chat.value.copy(trusted = true)
            openConversation(force = true)
        } catch (error: Throwable) {
            _chat.value = _chat.value.copy(loading = false, error = error.message ?: "工作目录校验失败")
        }
    }

    private suspend fun reloadCurrentChat() {
        if (_screen.value != AppScreen.Chat || !_chat.value.trusted) return
        hydratedKey = null
        _chat.value = _chat.value.copy(loading = _chat.value.messages.isEmpty())
        runCatching { openConversation(force = true) }
            .onFailure { _chat.value = _chat.value.copy(loading = false, error = it.message ?: "会话加载失败") }
    }

    private suspend fun ensureConversation(): String =
        _chat.value.liveSessionId ?: openConversation(force = false)

    private suspend fun openConversation(force: Boolean): String {
        val state = _chat.value
        val key = state.historySessionId ?: "new:${state.workspacePath}"
        if (!force && hydratedKey == key && state.liveSessionId != null) return state.liveSessionId
        val snapshot = client.call(
            "conversation.open",
            buildJsonObject {
                state.historySessionId?.let { put("conversationId", it) }
                put("workspacePath", state.workspacePath)
                put("subscribe", true)
            },
        ).jsonObject
        val conversation = snapshot.obj("conversation") ?: error("daemon 未返回 conversation")
        val runtime = snapshot.obj("runtime") ?: JsonObject(emptyMap())
        val config = snapshot.obj("config") ?: error("daemon 未返回 config")
        val conversationId = conversation.string("id") ?: error("daemon 未返回 conversationId")
        val runtimeId = runtime.string("runtimeId")
        val revision = snapshot.long("revision") ?: 0L
        val snapshotMessages = (snapshot["messages"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }

        hydratedKey = key
        sequenceRuntimeId = runtimeId
        if (lastSequence <= revision) {
            lastSequence = revision
            domainMessages = snapshotMessages
        } else {
            snapshotMessages.forEach { message ->
                if (domainMessages.none { it.string("id") == message.string("id") }) domainMessages += message
            }
        }
        registerAliases(
            conversationId,
            conversation.string("sdkSessionId"),
            runtimeId,
            state.historySessionId,
        )
        val model = config.obj("model")?.string("requestedId") ?: state.selectedModel
        val effort = Effort.fromRpc(config.obj("effort")?.string("requested"))
        val permissionMode = PermissionMode.fromRpc(config.string("permissionMode"))
        val runtimeState = runtime.string("state") ?: "cold"
        _chat.value = state.copy(
            historySessionId = conversationId,
            liveSessionId = conversationId,
            title = "会话 ${conversationId.take(8)}…",
            loading = false,
            selectedModel = model,
            effort = effort,
            permissionMode = permissionMode,
            busy = isBusy(runtimeState),
            runStatus = displayStatus(runtimeState),
            error = null,
        )
        rebuildChat()
        return conversationId
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
                selectedModel = configured?.string("default") ?: _models.value.first().id,
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
            val project = element as? JsonObject ?: return@forEach
            val path = project.string("workspacePath") ?: return@forEach
            val sessions = parseSessions(project["sessions"] as? JsonArray)
            sessionsByPath[path] = sessions
            workspaces[path] = Workspace(path, path, sessions.firstOrNull()?.lastTimestamp ?: "")
        }
        (workspacesResult["workspaces"] as? JsonArray).orEmpty().forEach { element ->
            val workspace = element as? JsonObject ?: return@forEach
            val path = workspace.string("path") ?: return@forEach
            workspaces[path] = Workspace(workspace.string("id") ?: path, path, workspace.string("createdAt") ?: "")
            if (sessionsByPath[path] == null) {
                sessionsByPath[path] = runCatching {
                    parseSessions(client.call("history.listSessions", params("workspacePath", path)).jsonObject["sessions"] as? JsonArray)
                }.getOrDefault(emptyList())
            }
        }
        return workspaces.values.map { workspace ->
            val sessions = sessionsByPath[workspace.path].orEmpty().sortedByDescending { it.lastTimestamp.orEmpty() }
            SessionGroup(workspace, sessions, sessions.firstOrNull()?.lastTimestamp ?: workspace.createdAt)
        }.sortedByDescending { it.latestAt }
    }

    private suspend fun loadActiveSessions(): List<ActiveSession> {
        val result = client.call("conversation.listActive").jsonObject
        return (result["sessions"] as? JsonArray).orEmpty().mapNotNull { element ->
            val row = element as? JsonObject ?: return@mapNotNull null
            ActiveSession(
                conversationId = row.string("conversationId") ?: return@mapNotNull null,
                sessionId = row.string("sessionId") ?: "",
                runtimeId = row.string("runtimeId") ?: "",
                cwd = row.string("cwd") ?: "",
                status = row.string("status") ?: "idle",
                runtimeStatus = row.string("runtimeStatus") ?: "running",
                subscriberCount = (row["subscriberCount"] as? JsonPrimitive)?.intOrNull ?: 0,
            )
        }
    }

    private fun activeMap(rows: List<ActiveSession>): Map<String, ActiveSession> = buildMap {
        rows.forEach { row ->
            listOf(row.conversationId, row.sessionId, row.runtimeId).filter(String::isNotBlank).forEach { put(it, row) }
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
                    runCatching { loadActiveSessions() }.onSuccess { _sessions.value = _sessions.value.copy(active = activeMap(it)) }
                }
            }
        }
    }

    private suspend fun handleNotification(notification: RpcNotification) {
        if (notification.method != "conversation/event") return
        val envelope = notification.params
        if (envelope.long("version") != 1L || !matchesCurrentConversation(envelope)) return
        val runtimeId = envelope.string("runtimeId")
        if (sequenceRuntimeId != runtimeId) {
            sequenceRuntimeId = runtimeId
            lastSequence = 0
        }
        val sequence = envelope.long("sequence") ?: return
        if (sequence <= lastSequence) return
        lastSequence = sequence
        val event = envelope.obj("event") ?: return
        when (event.string("type")) {
            "message_start", "message_update", "message_end" -> {
                val message = event.obj("message") ?: return
                domainMessages = MessageParser.upsert(domainMessages, message)
                rebuildChat()
            }
            "conversation_status" -> applyStatus(event.string("status"), event.string("error"))
            "runtime_status" -> if (event.string("status") == "crashed") applyStatus("crashed", event.string("error"))
            "runtime_initialized" -> {
                registerAliases(
                    envelope.string("conversationId"),
                    envelope.string("sessionId"),
                    envelope.string("runtimeId"),
                    event.string("sdkSessionId"),
                )
                event.string("model")?.let { _chat.value = _chat.value.copy(selectedModel = it) }
            }
            "turn_status" -> handleTurnStatus(event)
            "permission_request" -> handlePermission(envelope, event)
            "permission_resolved" -> handlePermissionResolved(envelope, event)
        }
    }

    private fun handleTurnStatus(event: JsonObject) {
        val status = event.string("status") ?: return
        val turnId = event.string("turnId")
        if (pendingTurn?.turnId == null && turnId != null && status in setOf("queued", "running")) {
            pendingTurn = pendingTurn?.copy(turnId = turnId)
            rebuildChat()
        }
        if (status in setOf("completed", "failed", "limited", "interrupted")) {
            pendingTurn = null
            val interrupted = interruptRequested || status == "interrupted"
            _chat.value = _chat.value.copy(
                busy = false,
                runStatus = if (interrupted) "已停止" else displayStatus(status),
                error = if (interrupted) null else event.string("error"),
            )
            interruptRequested = false
            rebuildChat()
            if (refreshAfterTurn) { refreshAfterTurn = false; refreshSessions() }
        }
    }

    private fun handlePermission(envelope: JsonObject, event: JsonObject) {
        val request = PermissionRequest(
            conversationId = envelope.string("conversationId") ?: return,
            requestId = event["requestId"] ?: return,
            toolName = event.string("toolName") ?: "Tool",
            input = event.obj("input") ?: JsonObject(emptyMap()),
        )
        pendingPermissions = PermissionQueue.upsert(pendingPermissions, request)
        syncPendingPermission()
    }

    private fun handlePermissionResolved(envelope: JsonObject, event: JsonObject) {
        val conversationId = envelope.string("conversationId") ?: return
        val requestId = event["requestId"] ?: return
        pendingPermissions = PermissionQueue.resolve(pendingPermissions, conversationId, requestId)
        syncPendingPermission()
    }

    private fun removePendingPermission(request: PermissionRequest) {
        pendingPermissions = PermissionQueue.resolve(pendingPermissions, request.conversationId, request.requestId)
        syncPendingPermission()
    }

    private fun syncPendingPermission() {
        _chat.value = _chat.value.copy(pendingPermission = pendingPermissions.firstOrNull())
    }

    private fun applyStatus(status: String?, error: String?) {
        val interrupted = interruptRequested || status == "interrupted"
        _chat.value = _chat.value.copy(
            busy = isBusy(status),
            runStatus = if (interrupted) "已停止" else displayStatus(status),
            error = if (interrupted) null else error,
        )
    }

    private fun rebuildChat() {
        val projected = MessageParser.project(domainMessages, pendingTurn)
        _chat.value = _chat.value.copy(messages = projected.messages, toolResults = projected.toolResults)
    }

    private fun registerAliases(vararg ids: String?) {
        ids.filterNotNull().filter(String::isNotBlank).forEach(conversationAliases::add)
    }

    private fun matchesCurrentConversation(envelope: JsonObject): Boolean {
        if (_screen.value != AppScreen.Chat) return false
        val ids = listOfNotNull(
            envelope.string("conversationId"),
            envelope.string("sessionId"),
            envelope.string("runtimeId"),
        )
        if (conversationAliases.isEmpty()) return _chat.value.liveSessionId == null
        return ids.any { it in conversationAliases || it == _chat.value.liveSessionId || it == _chat.value.historySessionId }
    }

    private fun isBusy(status: String?): Boolean = status in setOf("spawning", "starting", "queued", "running", "waiting_permission", "closing")

    private fun displayStatus(status: String?): String? = when (status) {
        null, "cold", "idle", "closed", "completed" -> null
        "spawning", "starting" -> "启动中"
        "queued" -> "排队中"
        "running" -> "运行中"
        "waiting_permission" -> "等待授权"
        "closing" -> "结束中"
        "interrupted" -> "已停止"
        "failed", "limited", "error", "crashed" -> "失败"
        else -> status
    }

    private fun params(key: String, value: String): JsonObject = buildJsonObject { put(key, value) }

    private fun defaultModels() = listOf(
        ModelOption("claude-sonnet-4-6", "Sonnet"),
        ModelOption("claude-opus-4-7", "Opus"),
        ModelOption("claude-haiku-4-5-20251001", "Haiku"),
    )
}
