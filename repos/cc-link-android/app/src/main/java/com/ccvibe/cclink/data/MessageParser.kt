package com.ccvibe.cclink.data

import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

data class ParsedHistory(
    val messages: List<ChatMessage>,
    val toolResults: Map<String, ToolResult>,
)

object MessageParser {
    fun parseHistory(entries: JsonArray): ParsedHistory {
        val messages = mutableListOf<ChatMessage>()
        val toolResults = mutableMapOf<String, ToolResult>()

        entries.forEachIndexed { index, element ->
            val entry = element as? JsonObject ?: return@forEachIndexed
            if (entry.boolean("isCompactSummary") || entry.boolean("isVisibleInTranscriptOnly")) return@forEachIndexed
            if (entry.string("subtype") == "compact_boundary") return@forEachIndexed
            val type = entry.string("type") ?: return@forEachIndexed
            val message = entry.obj("message") ?: return@forEachIndexed
            val content = message["content"]

            if (type == "user") {
                val blocks = content as? JsonArray
                if (blocks != null && blocks.isNotEmpty() && blocks.all { (it as? JsonObject)?.string("type") == "tool_result" }) {
                    blocks.forEach { parseToolResult(it as? JsonObject, toolResults) }
                    return@forEachIndexed
                }
                val text = textContent(content)
                if (text.isNotBlank()) {
                    messages += ChatMessage(
                        id = entry.string("uuid") ?: "history-user-$index",
                        role = MessageRole.USER,
                        userText = text,
                    )
                }
            } else if (type == "assistant") {
                val parsedBlocks = parseBlocks(content)
                if (parsedBlocks.isEmpty()) return@forEachIndexed
                val next = ChatMessage(
                    id = entry.string("uuid") ?: "history-assistant-$index",
                    role = MessageRole.ASSISTANT,
                    blocks = parsedBlocks,
                    model = message.string("model"),
                    metrics = metricsFrom(message, entry),
                )
                val previous = messages.lastOrNull()
                if (previous?.role == MessageRole.ASSISTANT) {
                    messages[messages.lastIndex] = previous.copy(
                        blocks = mergeAdjacent(previous.blocks + next.blocks),
                        model = next.model ?: previous.model,
                        metrics = next.metrics ?: previous.metrics,
                    )
                } else {
                    messages += next
                }
            }
        }
        return ParsedHistory(messages, toolResults)
    }

    fun parseBlocks(content: JsonElement?): List<MessageBlock> {
        if (content is JsonPrimitive && content.isString) {
            return content.contentOrNull?.takeIf { it.isNotBlank() }?.let { listOf(MessageBlock.Text(it)) }.orEmpty()
        }
        val array = content as? JsonArray ?: return emptyList()
        return array.mapNotNull { element ->
            val block = element as? JsonObject ?: return@mapNotNull null
            when (block.string("type")) {
                "text" -> block.string("text")?.let(MessageBlock::Text)
                "thinking" -> block.string("thinking")?.let(MessageBlock::Thinking)
                "tool_use" -> MessageBlock.ToolUse(
                    id = block.string("id") ?: UUID.randomUUID().toString(),
                    name = block.string("name") ?: "Tool",
                    input = block.obj("input") ?: JsonObject(emptyMap()),
                )
                else -> null
            }
        }
    }

    fun parseAssistantSnapshot(event: JsonObject): Pair<List<MessageBlock>, String?> {
        val message = event.obj("message") ?: return emptyList<MessageBlock>() to null
        return parseBlocks(message["content"]) to message.string("model")
    }

    fun applyStreamDelta(blocks: List<MessageBlock>, event: JsonObject): List<MessageBlock> {
        val stream = event.obj("event") ?: return blocks
        val delta = stream.obj("delta") ?: return blocks
        val value = delta.string("text") ?: delta.string("thinking") ?: return blocks
        return when (delta.string("type")) {
            "thinking_delta" -> appendThinking(blocks, value)
            "text_delta" -> appendText(blocks, value)
            else -> if (delta["thinking"] != null) appendThinking(blocks, value) else appendText(blocks, value)
        }
    }

    fun updateToolResultsFromEvent(event: JsonObject, current: Map<String, ToolResult>): Map<String, ToolResult> {
        val message = event.obj("message")
        val content = message?.get("content") as? JsonArray ?: return current
        val next = current.toMutableMap()
        content.forEach { parseToolResult(it as? JsonObject, next) }
        return next
    }

    fun toolIds(blocks: List<MessageBlock>): List<String> = blocks.mapNotNull { (it as? MessageBlock.ToolUse)?.id }

    fun resultMetrics(event: JsonObject, elapsedFallback: Long?): MessageMetrics? {
        val usage = event.obj("usage")
        val input = usage?.long("input_tokens") ?: usage?.long("input")
        val output = usage?.long("output_tokens") ?: usage?.long("output")
        val durationMs = event.long("duration_ms") ?: event.long("durationMs") ?: event.long("elapsed_ms")
        val elapsed = durationMs?.div(1000) ?: elapsedFallback
        if (input == null && output == null && elapsed == null) return null
        return MessageMetrics(input, output, elapsed)
    }

    private fun parseToolResult(block: JsonObject?, target: MutableMap<String, ToolResult>) {
        if (block?.string("type") != "tool_result") return
        val id = block.string("tool_use_id") ?: return
        val isError = block.boolean("is_error")
        target[id] = ToolResult(
            status = if (isError) ToolStatus.FAILED else ToolStatus.SUCCESS,
            content = textContent(block["content"]),
            isError = isError,
        )
    }

    private fun textContent(content: JsonElement?): String = when (content) {
        is JsonPrimitive -> content.contentOrNull.orEmpty()
        is JsonArray -> content.joinToString("\n") { element ->
            val block = element as? JsonObject
            block?.string("text") ?: if (block?.string("type") == "tool_result") textContent(block["content"]) else ""
        }.trim()
        else -> ""
    }

    private fun metricsFrom(message: JsonObject, entry: JsonObject): MessageMetrics? {
        val usage = message.obj("usage")
        val input = usage?.long("input_tokens") ?: usage?.long("input")
        val output = usage?.long("output_tokens") ?: usage?.long("output")
        val duration = entry.long("duration_ms") ?: entry.long("elapsed_ms")
        if (input == null && output == null && duration == null) return null
        return MessageMetrics(input, output, duration?.div(1000))
    }

    private fun appendText(blocks: List<MessageBlock>, text: String): List<MessageBlock> {
        val next = blocks.toMutableList()
        val last = next.lastOrNull()
        if (last is MessageBlock.Text) next[next.lastIndex] = last.copy(text = last.text + text)
        else next += MessageBlock.Text(text)
        return next
    }

    private fun appendThinking(blocks: List<MessageBlock>, text: String): List<MessageBlock> {
        val next = blocks.toMutableList()
        val last = next.lastOrNull()
        if (last is MessageBlock.Thinking) next[next.lastIndex] = last.copy(text = last.text + text)
        else next += MessageBlock.Thinking(text)
        return next
    }

    private fun mergeAdjacent(blocks: List<MessageBlock>): List<MessageBlock> {
        val merged = mutableListOf<MessageBlock>()
        blocks.forEach { block ->
            val last = merged.lastOrNull()
            when {
                block is MessageBlock.Text && last is MessageBlock.Text -> merged[merged.lastIndex] = last.copy(text = last.text + block.text)
                block is MessageBlock.Thinking && last is MessageBlock.Thinking -> merged[merged.lastIndex] = last.copy(text = last.text + block.text)
                else -> merged += block
            }
        }
        return merged
    }
}

internal fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
internal fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
internal fun JsonObject.boolean(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull == true
internal fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
