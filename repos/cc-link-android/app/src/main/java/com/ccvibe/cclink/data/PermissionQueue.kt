package com.ccvibe.cclink.data

import kotlinx.serialization.json.JsonElement

object PermissionQueue {
    fun upsert(queue: List<PermissionRequest>, request: PermissionRequest): List<PermissionRequest> {
        val index = queue.indexOfFirst { same(it, request.conversationId, request.requestId) }
        if (index < 0) return queue + request
        return queue.toMutableList().also { it[index] = request }
    }

    fun resolve(
        queue: List<PermissionRequest>,
        conversationId: String,
        requestId: JsonElement,
    ): List<PermissionRequest> = queue.filterNot { same(it, conversationId, requestId) }

    private fun same(request: PermissionRequest, conversationId: String, requestId: JsonElement): Boolean {
        return request.conversationId == conversationId && request.requestId == requestId
    }
}
