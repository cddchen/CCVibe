package com.ccvibe.cclink.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MessageParserTest {
    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun projectsDomainMessagesAndToolResults() {
        val domain = parse(
            """[
              {"type":"user_message","id":"u1","turnId":"t1","timestamp":"1","status":"completed","content":"hello"},
              {"type":"agent_message","id":"a1","turnId":"t1","timestamp":"2","status":"completed","model":"sonnet","content":[
                {"type":"thinking","thinking":"plan"},
                {"type":"tool_call","toolCallId":"tool-1","toolName":"Read","input":{"file_path":"README.md"},"status":"completed"},
                {"type":"text","text":"done"}
              ]},
              {"type":"tool_result","id":"r1","turnId":"t1","timestamp":"3","status":"completed","toolCallId":"tool-1","content":"contents","isError":false}
            ]""",
        )

        val projected = MessageParser.project(domain)

        assertEquals(2, projected.messages.size)
        assertEquals(MessageRole.USER, projected.messages[0].role)
        assertEquals(3, projected.messages[1].blocks.size)
        assertEquals(ToolStatus.SUCCESS, projected.toolResults.getValue("tool-1").status)
        assertEquals("contents", projected.toolResults.getValue("tool-1").content)
    }

    @Test
    fun groupsAllAgentMessagesInOneTurnIntoOneBubble() {
        val domain = parse(
            """[
              {"type":"agent_message","id":"a1","turnId":"t1","timestamp":"1","status":"completed","metrics":{"usage":{"input":10,"output":2}},"content":[{"type":"thinking","thinking":"plan"}]},
              {"type":"agent_message","id":"a2","turnId":"t1","timestamp":"2","status":"completed","metrics":{"usage":{"input":3,"output":4}},"content":[{"type":"tool_call","toolCallId":"x","toolName":"Read","input":{},"status":"completed"}]},
              {"type":"agent_message","id":"a3","turnId":"t1","timestamp":"3","status":"completed","content":[{"type":"text","text":"answer"}]}
            ]""",
        )

        val assistants = MessageParser.project(domain).messages.filter { it.role == MessageRole.ASSISTANT }

        assertEquals(1, assistants.size)
        assertEquals(3, assistants.single().blocks.size)
        assertEquals(13L, assistants.single().metrics?.inputTokens)
        assertEquals(6L, assistants.single().metrics?.outputTokens)
    }

    @Test
    fun replacesMessageSnapshotById() {
        val streaming = parse("""[{"type":"agent_message","id":"a1","turnId":"t1","timestamp":"1","status":"streaming","content":[]}]""").single()
        val completed = parse("""[{"type":"agent_message","id":"a1","turnId":"t1","timestamp":"1","status":"completed","content":[{"type":"text","text":"answer"}]}]""").single()

        val result = MessageParser.upsert(listOf(streaming), completed)

        assertEquals(1, result.size)
        assertEquals("completed", result.single().string("status"))
    }

    @Test
    fun pendingFeedbackDisappearsWhenTurnMessagesArrive() {
        val domain = parse("""[{"type":"user_message","id":"u1","turnId":"t1","timestamp":"1","status":"completed","content":"hello"}]""")
        val projected = MessageParser.project(domain, PendingTurnFeedback("client-1", "hello", "t1"))

        assertEquals(listOf("u1"), projected.messages.filter { it.role == MessageRole.USER }.map { it.id })
        assertTrue(projected.messages.any { it.id == "pending-agent:client-1" })
        assertFalse(projected.messages.any { it.id == "pending-user:client-1" })
    }

    @Test
    fun pendingFeedbackDeduplicatesBeforeSendReceiptProvidesTurnId() {
        val domain = parse(
            """[
              {"type":"user_message","id":"u1","turnId":"t1","timestamp":"1","status":"completed","content":"hello"},
              {"type":"agent_message","id":"a1","turnId":"t1","timestamp":"2","status":"streaming","content":[]}
            ]""",
        )

        val projected = MessageParser.project(domain, PendingTurnFeedback("client-1", "hello"))

        assertFalse(projected.messages.any { it.id.startsWith("pending-") })
        assertEquals(1, projected.messages.count { it.role == MessageRole.USER })
        assertEquals(1, projected.messages.count { it.role == MessageRole.ASSISTANT })
    }

    @Test
    fun activeTurnKeepsAssistantStreamingAfterCurrentSnapshotCompletes() {
        val domain = parse(
            """[
              {"type":"user_message","id":"u1","turnId":"t1","timestamp":"1","status":"completed","content":"hello"},
              {"type":"agent_message","id":"a1","turnId":"t1","timestamp":"2","status":"completed","content":[{"type":"thinking","thinking":"done thinking"}]}
            ]""",
        )

        val projected = MessageParser.project(domain, PendingTurnFeedback("client-1", "hello", "t1"))

        assertTrue(projected.messages.single { it.role == MessageRole.ASSISTANT }.streaming)
    }

    private fun parse(raw: String): List<JsonObject> =
        (json.parseToJsonElement(raw) as JsonArray).map { it as JsonObject }
}
