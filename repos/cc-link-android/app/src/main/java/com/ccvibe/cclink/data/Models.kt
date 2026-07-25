package com.ccvibe.cclink.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

data class ConnectionConfig(
    val host: String,
    val port: Int,
    val useTls: Boolean,
    val token: String,
    val path: String = "/ws",
) {
    val baseUrl: String
        get() {
            val scheme = if (useTls) "wss" else "ws"
            val normalizedPath = if (path.startsWith('/')) path else "/$path"
            return "$scheme://$host:$port$normalizedPath"
        }
}

sealed interface ConnectionState {
    data object Disconnected : ConnectionState
    data object Connecting : ConnectionState
    data class Connected(val config: ConnectionConfig) : ConnectionState
    data class Reconnecting(val attempt: Int) : ConnectionState
    data class Failed(val message: String) : ConnectionState
}

data class RpcNotification(val method: String, val params: JsonObject)

data class Workspace(
    val id: String,
    val path: String,
    val createdAt: String,
)

data class HistorySession(
    val sessionId: String,
    val messageCount: Int,
    val lastTimestamp: String?,
    val title: String? = null,
)

data class ActiveSession(
    val conversationId: String,
    val sessionId: String,
    val runtimeId: String,
    val cwd: String,
    val status: String,
    val runtimeStatus: String,
    val subscriberCount: Int,
)

data class SessionGroup(
    val workspace: Workspace,
    val sessions: List<HistorySession>,
    val latestAt: String,
)

data class ModelOption(val id: String, val label: String)

enum class Effort(val label: String) {
    LOW("低"),
    MEDIUM("中"),
    HIGH("高"),
    XHIGH("极高"),
    MAX("最高");

    val rpcValue: String get() = name.lowercase()

    companion object {
        fun fromRpc(value: String?): Effort = entries.firstOrNull { it.rpcValue == value } ?: HIGH
    }
}

enum class PermissionMode(val rpcValue: String, val label: String) {
    DEFAULT("default", "Default"),
    ACCEPT_EDITS("acceptEdits", "Accept Edits"),
    PLAN("plan", "Plan Mode"),
    AUTO("auto", "Auto Mode"),
    BYPASS("bypassPermissions", "Bypass Permissions"),
    DONT_ASK("dontAsk", "Don't Ask");

    companion object {
        fun fromRpc(value: String?): PermissionMode = entries.firstOrNull { it.rpcValue == value } ?: ACCEPT_EDITS
    }
}

sealed interface MessageBlock {
    data class Text(val text: String) : MessageBlock
    data class Thinking(val text: String) : MessageBlock
    data class ToolUse(
        val id: String,
        val name: String,
        val input: JsonObject,
    ) : MessageBlock
}

enum class MessageRole { USER, ASSISTANT, SYSTEM }

data class MessageMetrics(
    val inputTokens: Long? = null,
    val outputTokens: Long? = null,
    val elapsedSeconds: Double? = null,
)

data class ChatMessage(
    val id: String,
    val role: MessageRole,
    val userText: String? = null,
    val blocks: List<MessageBlock> = emptyList(),
    val streaming: Boolean = false,
    val model: String? = null,
    val metrics: MessageMetrics? = null,
    val error: String? = null,
)

enum class ToolStatus { WAITING_PERMISSION, RUNNING, SUCCESS, FAILED, DENIED }

data class ToolResult(
    val status: ToolStatus,
    val content: String = "",
    val isError: Boolean = false,
)

data class PermissionRequest(
    val conversationId: String,
    val requestId: JsonElement,
    val toolName: String,
    val input: JsonObject,
)

data class PendingTurnFeedback(
    val clientMessageId: String,
    val content: String,
    val turnId: String? = null,
)

data class AskQuestion(
    val question: String,
    val header: String,
    val options: List<String>,
    val multiSelect: Boolean,
)

data class ChatState(
    val workspacePath: String = "",
    val historySessionId: String? = null,
    val liveSessionId: String? = null,
    val title: String = "新会话",
    val trusted: Boolean = false,
    val trustPath: String? = null,
    val trustParent: String? = null,
    val loading: Boolean = false,
    val messages: List<ChatMessage> = emptyList(),
    val toolResults: Map<String, ToolResult> = emptyMap(),
    val busy: Boolean = false,
    val runStatus: String? = null,
    val error: String? = null,
    val draft: String = "",
    val selectedModel: String = "claude-sonnet-4-6",
    val effort: Effort = Effort.HIGH,
    val permissionMode: PermissionMode = PermissionMode.ACCEPT_EDITS,
    val pendingPermission: PermissionRequest? = null,
)
