package com.ccvibe.cclink.network

import com.ccvibe.cclink.data.ConnectionConfig
import java.net.URI

object ConnectionAddress {
    fun resolve(hostOrUrl: String, portText: String, useTls: Boolean, token: String): ConnectionConfig {
        val input = hostOrUrl.trim()
        require(input.isNotEmpty()) { "请填写主机或 WebSocket 地址" }
        require(token.trim().isNotEmpty()) { "请填写 Token" }

        if (input.startsWith("ws://", true) || input.startsWith("wss://", true)) {
            val uri = URI(input)
            require(!uri.host.isNullOrBlank()) { "无法解析连接地址" }
            val tls = uri.scheme.equals("wss", true)
            return ConnectionConfig(
                host = uri.host,
                port = if (uri.port > 0) uri.port else if (tls) 443 else 80,
                useTls = tls,
                token = token.trim(),
                path = uri.rawPath?.takeIf { it.isNotBlank() && it != "/" } ?: "/ws",
            )
        }

        val port = portText.toIntOrNull()
        require(port != null && port in 1..65535) { "端口必须是 1 到 65535 之间的数字" }
        return ConnectionConfig(
            host = input.removePrefix("[").removeSuffix("]"),
            port = port,
            useTls = useTls,
            token = token.trim(),
        )
    }
}
