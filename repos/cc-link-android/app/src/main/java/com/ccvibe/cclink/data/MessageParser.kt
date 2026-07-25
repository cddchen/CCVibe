package com.ccvibe.cclink.data

import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

data class ProjectedConversation(
    val messages: List<ChatMessage>,
    val toolResults: Map<String, ToolResult>,
)

object MessageParser {
    /** Projects daemon-owned ConversationMessage snapshots. SDK wire messages are intentionally unsupported. */
    fun project(
        domainMessages: List<JsonObject>,
        pendingTurn: PendingTurnFeedback? = null,
    ): ProjectedConversation {
        val messages = mutableListOf<ChatMessage>()
        val tools = mutableMapOf<String, ToolResult>()
        val agentIndexByTurn = mutableMapOf<String, Int>()

        domainMessages.forEach { message ->
            when (message.string("type")) {
                "user_message" -> {
                    val text = textContent(message["content"])
                    if (text.isNotBlank()) {
                        messages += ChatMessage(
                            id = message.string("id") ?: UUID.randomUUID().toString(),
                            role = MessageRole.USER,
                            userText = text,
                        )
                    }
                }
                "agent_message" -> {
                    val blocks = parseAgentBlocks(message["content"])
                    updateToolStatesFromAgent(message["content"], tools)
                    val streaming = message.string("status") == "streaming"
                    if (blocks.isEmpty() && !streaming) return@forEach
                    val turnKey = message.string("turnId") ?: message.string("id") ?: UUID.randomUUID().toString()
                    val metrics = parseMetrics(message.obj("metrics"))
                    val existingIndex = agentIndexByTurn[turnKey]
                    if (existingIndex == null) {
                        agentIndexByTurn[turnKey] = messages.size
                        messages += ChatMessage(
                            id = message.string("id") ?: "agent-turn:$turnKey",
                            role = MessageRole.ASSISTANT,
                            blocks = blocks,
                            streaming = streaming,
                            model = message.string("model"),
                            metrics = metrics,
                        )
                    } else {
                        val current = messages[existingIndex]
                        messages[existingIndex] = current.copy(
                            blocks = current.blocks + blocks,
                            streaming = current.streaming || streaming,
                            model = message.string("model") ?: current.model,
                            metrics = mergeMetrics(current.metrics, metrics),
                        )
                    }
                }
                "tool_result" -> {
                    val id = message.string("toolCallId") ?: return@forEach
                    val isError = message.boolean("isError")
                    tools[id] = ToolResult(
                        status = if (isError) ToolStatus.FAILED else ToolStatus.SUCCESS,
                        content = textContent(message["content"]),
                        isError = isError,
                    )
                }
                "model_changed" -> messages += systemMessage(
                    message,
                    "模型已切换为 ${message.string("modelId").orEmpty()}",
                )
                "effort_changed" -> messages += systemMessage(
                    message,
                    "思考强度已切换为 ${message.string("effort").orEmpty()}",
                )
                "permission_mode_changed" -> messages += systemMessage(
                    message,
                    "权限模式已切换为 ${message.string("mode").orEmpty()}",
                )
                "system_message" -> textContent(message["content"]).takeIf(String::isNotBlank)?.let { text ->
                    messages += systemMessage(message, text)
                }
            }
        }

        pendingTurn?.let { pending ->
            val resolvedTurnId = pending.turnId ?: domainMessages.asReversed().firstOrNull {
                it.string("type") == "user_message" && textContent(it["content"]) == pending.content
            }?.string("turnId")
            val hasUser = resolvedTurnId?.let { turnId ->
                domainMessages.any { it.string("type") == "user_message" && it.string("turnId") == turnId }
            } == true || domainMessages.any {
                it.string("type") == "user_message" && textContent(it["content"]) == pending.content
            }
            val hasAgent = resolvedTurnId?.let { turnId ->
                domainMessages.any { it.string("type") == "agent_message" && it.string("turnId") == turnId }
            } == true
            resolvedTurnId?.let(agentIndexByTurn::get)?.let { index ->
                messages[index] = messages[index].copy(streaming = true)
            }
            if (!hasUser) {
                messages += ChatMessage(
                    id = "pending-user:${pending.clientMessageId}",
                    role = MessageRole.USER,
                    userText = pending.content,
                )
            }
            if (!hasAgent) {
                messages += ChatMessage(
                    id = "pending-agent:${pending.clientMessageId}",
                    role = MessageRole.ASSISTANT,
                    streaming = true,
                )
            }
        }

        return ProjectedConversation(messages, tools)
    }

    fun upsert(messages: List<JsonObject>, message: JsonObject): List<JsonObject> {
        val id = message.string("id") ?: return messages
        val index = messages.indexOfFirst { it.string("id") == id }
        if (index < 0) return messages + message
        return messages.toMutableList().also { it[index] = message }
    }

    private fun systemMessage(message: JsonObject, text: String) = ChatMessage(
        id = message.string("id") ?: UUID.randomUUID().toString(),
        role = MessageRole.SYSTEM,
        userText = text,
    )

    private fun parseAgentBlocks(content: JsonElement?): List<MessageBlock> =
        (content as? JsonArray).orEmpty().mapNotNull { element ->
            val block = element as? JsonObject ?: return@mapNotNull null
            when (block.string("type")) {
                "text" -> block.string("text")?.let(MessageBlock::Text)
                "thinking" -> block.string("thinking")?.takeIf(String::isNotBlank)?.let(MessageBlock::Thinking)
                "tool_call" -> MessageBlock.ToolUse(
                    id = block.string("toolCallId") ?: UUID.randomUUID().toString(),
                    name = block.string("toolName") ?: "Tool",
                    input = block.obj("input") ?: JsonObject(emptyMap()),
                )
                else -> null
            }
        }

    private fun updateToolStatesFromAgent(content: JsonElement?, target: MutableMap<String, ToolResult>) {
        (content as? JsonArray).orEmpty().forEach { element ->
            val block = element as? JsonObject ?: return@forEach
            if (block.string("type") != "tool_call") return@forEach
            val id = block.string("toolCallId") ?: return@forEach
            val status = when (block.string("status")) {
                "completed" -> ToolStatus.SUCCESS
                "failed" -> ToolStatus.FAILED
                "denied" -> ToolStatus.DENIED
                "waiting_permission" -> ToolStatus.WAITING_PERMISSION
                else -> ToolStatus.RUNNING
            }
            val current = target[id]
            target[id] = ToolResult(status, current?.content.orEmpty(), current?.isError == true)
        }
    }

    private fun parseMetrics(metrics: JsonObject?): MessageMetrics? {
        metrics ?: return null
        val usage = metrics.obj("usage")
        val input = usage?.long("input")
        val output = usage?.long("output")
        val elapsed = metrics.double("elapsedSeconds")
        if (input == null && output == null && elapsed == null) return null
        return MessageMetrics(input, output, elapsed)
    }

    private fun mergeMetrics(current: MessageMetrics?, next: MessageMetrics?): MessageMetrics? {
        if (next == null) return current
        if (current == null) return next
        fun sum(a: Long?, b: Long?): Long? = if (a == null && b == null) null else (a ?: 0) + (b ?: 0)
        return MessageMetrics(
            inputTokens = sum(current.inputTokens, next.inputTokens),
            outputTokens = sum(current.outputTokens, next.outputTokens),
            elapsedSeconds = next.elapsedSeconds ?: current.elapsedSeconds,
        )
    }

    private fun textContent(content: JsonElement?): String = when (content) {
        is JsonPrimitive -> content.contentOrNull.orEmpty()
        is JsonArray -> content.mapNotNull { element ->
            val block = element as? JsonObject ?: return@mapNotNull null
            block.string("text")
        }.joinToString("\n")
        else -> ""
    }
}

internal fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
internal fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
internal fun JsonObject.double(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull
internal fun JsonObject.boolean(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull == true
internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
