package com.ccvibe.cclink.network

import android.net.Uri
import com.ccvibe.cclink.data.ConnectionConfig
import com.ccvibe.cclink.data.ConnectionState
import com.ccvibe.cclink.data.RpcNotification
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

class DaemonClient {
    private val json = Json { ignoreUnknownKeys = true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private val connectMutex = Mutex()
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Disconnected)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _notifications = MutableSharedFlow<RpcNotification>(extraBufferCapacity = 128)
    val notifications: SharedFlow<RpcNotification> = _notifications.asSharedFlow()

    private val _reconnected = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val reconnected: SharedFlow<Unit> = _reconnected.asSharedFlow()

    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var activeConfig: ConnectionConfig? = null
    @Volatile private var intentionalClose = true
    private var reconnectJob: Job? = null
    private var socketReady: CompletableDeferred<Unit>? = null

    suspend fun connect(config: ConnectionConfig) = connectMutex.withLock {
        intentionalClose = false
        activeConfig = config
        reconnectJob?.cancel()
        reconnectJob = null
        _state.value = ConnectionState.Connecting
        try {
            openAndAuthenticate(config)
            _state.value = ConnectionState.Connected(config)
        } catch (error: Throwable) {
            intentionalClose = true
            webSocket?.cancel()
            webSocket = null
            rejectPending(error)
            val message = friendlyMessage(error)
            _state.value = ConnectionState.Failed(message)
            throw IllegalStateException(message, error)
        }
    }

    fun disconnect() {
        intentionalClose = true
        reconnectJob?.cancel()
        reconnectJob = null
        rejectPending(CancellationException("connection closed"))
        webSocket?.close(1000, "client disconnect")
        webSocket = null
        _state.value = ConnectionState.Disconnected
    }

    suspend fun call(method: String, params: JsonObject = JsonObject(emptyMap())): JsonElement {
        val socket = webSocket ?: error("未连接 daemon")
        val id = nextId.getAndIncrement()
        val deferred = CompletableDeferred<JsonElement>()
        pending[id] = deferred
        val payload = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            put("params", params)
        }
        if (!socket.send(payload.toString())) {
            pending.remove(id)
            error("连接不可用")
        }
        return try {
            withTimeout(30_000) { deferred.await() }
        } finally {
            pending.remove(id)
        }
    }

    fun close() {
        disconnect()
        scope.cancel()
        httpClient.dispatcher.executorService.shutdown()
    }

    private suspend fun openAndAuthenticate(config: ConnectionConfig) {
        webSocket?.cancel()
        val ready = CompletableDeferred<Unit>()
        socketReady = ready
        val url = Uri.parse(config.baseUrl).buildUpon()
            .appendQueryParameter("token", config.token)
            .build()
            .toString()
        val request = Request.Builder().url(url).build()
        val socket = httpClient.newWebSocket(request, listener)
        webSocket = socket
        withTimeout(15_000) { ready.await() }
        call("auth", buildJsonObject { put("token", config.token) })
        val ping = call("ping").jsonObject
        check((ping["ok"] as? JsonPrimitive)?.content == "true") { "daemon ping 校验失败" }
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (this@DaemonClient.webSocket === webSocket) socketReady?.complete(Unit)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val message = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
            val id = (message["id"] as? JsonPrimitive)?.longOrNull
            if (id != null && message["method"] == null) {
                val deferred = pending.remove(id) ?: return
                val error = message["error"] as? JsonObject
                if (error != null) {
                    val errorMessage = (error["message"] as? JsonPrimitive)?.content ?: "RPC 调用失败"
                    deferred.completeExceptionally(IllegalStateException(errorMessage))
                } else {
                    deferred.complete(message["result"] ?: JsonNull)
                }
                return
            }
            val method = (message["method"] as? JsonPrimitive)?.content ?: return
            val params = message["params"] as? JsonObject ?: JsonObject(emptyMap())
            _notifications.tryEmit(RpcNotification(method, params))
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            onSocketLost(webSocket, IllegalStateException(reason.ifBlank { "连接已关闭" }))
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            socketReady?.completeExceptionally(t)
            onSocketLost(webSocket, t)
        }
    }

    private fun onSocketLost(socket: WebSocket, error: Throwable) {
        if (webSocket !== socket) return
        webSocket = null
        rejectPending(error)
        if (intentionalClose) return
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        val config = activeConfig ?: return
        reconnectJob = scope.launch {
            var attempt = 0
            while (!intentionalClose) {
                _state.value = ConnectionState.Reconnecting(attempt + 1)
                val waitMs = minOf(1_000L shl attempt.coerceAtMost(5), 30_000L)
                delay(waitMs)
                try {
                    openAndAuthenticate(config)
                    _state.value = ConnectionState.Connected(config)
                    _reconnected.emit(Unit)
                    return@launch
                } catch (_: Throwable) {
                    webSocket?.cancel()
                    webSocket = null
                    attempt += 1
                }
            }
        }
    }

    private fun rejectPending(error: Throwable) {
        pending.values.forEach { it.completeExceptionally(error) }
        pending.clear()
    }

    private fun friendlyMessage(error: Throwable): String {
        val message = error.message.orEmpty()
        return when {
            message.contains("invalid token", true) || message.contains("unauthorized", true) -> "Token 错误"
            message.contains("timeout", true) || message.contains("timed out", true) -> "连接超时，请检查地址和端口"
            message.contains("certificate", true) || message.contains("SSL", true) -> "TLS 或证书校验失败"
            message.isNotBlank() -> message
            else -> "无法连接 daemon"
        }
    }
}
