package com.ccvibe.cclink.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageParserTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun filtersCompactRowsAndAssociatesToolResults() {
        val entries = json.parseToJsonElement(
            """
            [
              {"type":"user","isCompactSummary":true,"message":{"content":"hidden"}},
              {"type":"user","uuid":"u1","message":{"content":"hello"}},
              {"type":"assistant","uuid":"a1","message":{"model":"sonnet","content":[
                {"type":"thinking","thinking":"checking"},
                {"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"pwd"}},
                {"type":"text","text":"done"}
              ]}},
              {"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"tool-1","content":"/tmp","is_error":false}
              ]}}
            ]
            """.trimIndent(),
        ).jsonArray

        val parsed = MessageParser.parseHistory(entries)
        assertEquals(2, parsed.messages.size)
        assertEquals("hello", parsed.messages[0].userText)
        assertEquals(3, parsed.messages[1].blocks.size)
        assertEquals(ToolStatus.SUCCESS, parsed.toolResults["tool-1"]?.status)
        assertEquals("/tmp", parsed.toolResults["tool-1"]?.content)
    }

    @Test
    fun appendsStreamingTextAndThinkingDeltas() {
        val textEvent = json.parseToJsonElement(
            """{"event":{"delta":{"type":"text_delta","text":"hello"}}}""",
        ).jsonObject
        val thinkingEvent = json.parseToJsonElement(
            """{"event":{"delta":{"type":"thinking_delta","thinking":"plan"}}}""",
        ).jsonObject

        val afterText = MessageParser.applyStreamDelta(emptyList(), textEvent)
        val afterThinking = MessageParser.applyStreamDelta(afterText, thinkingEvent)
        assertEquals(MessageBlock.Text("hello"), afterThinking[0])
        assertEquals(MessageBlock.Thinking("plan"), afterThinking[1])
    }

    @Test
    fun preservesFailedToolResult() {
        val entries = json.parseToJsonElement(
            """[{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"x","content":"boom","is_error":true}]}}]""",
        ).jsonArray
        val result = MessageParser.parseHistory(entries).toolResults.getValue("x")
        assertTrue(result.isError)
        assertEquals(ToolStatus.FAILED, result.status)
        assertFalse(result.content.isBlank())
    }
}
