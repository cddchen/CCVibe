package com.ccvibe.cclink.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

class PermissionQueueTest {
    private val first = PermissionRequest("c1", JsonPrimitive("r1"), "Read", JsonObject(emptyMap()))
    private val second = PermissionRequest("c1", JsonPrimitive("r2"), "Bash", JsonObject(emptyMap()))

    @Test
    fun queuesParallelRequestsAndResolvesOnlyTheMatchingRequest() {
        val queue = PermissionQueue.upsert(PermissionQueue.upsert(emptyList(), first), second)
        assertEquals(listOf("r1", "r2"), queue.map { it.requestId.toString().trim('"') })
        assertEquals(listOf(second), PermissionQueue.resolve(queue, "c1", JsonPrimitive("r1")))
    }
}
