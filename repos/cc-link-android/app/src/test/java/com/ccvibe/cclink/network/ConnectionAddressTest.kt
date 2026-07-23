package com.ccvibe.cclink.network

import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class ConnectionAddressTest {
    @Test
    fun resolvesHostPortAndTls() {
        val config = ConnectionAddress.resolve("192.168.1.8", "4733", false, "secret")
        assertEquals("ws://192.168.1.8:4733/ws", config.baseUrl)
        assertEquals("secret", config.token)
    }

    @Test
    fun resolvesCompleteWebSocketUrl() {
        val config = ConnectionAddress.resolve("wss://agent.example.com:8443/custom", "4733", false, "token")
        assertEquals("agent.example.com", config.host)
        assertEquals(8443, config.port)
        assertEquals(true, config.useTls)
        assertEquals("/custom", config.path)
    }

    @Test
    fun rejectsInvalidPort() {
        try {
            ConnectionAddress.resolve("host", "70000", false, "token")
            fail("expected invalid port")
        } catch (_: IllegalArgumentException) {
            // expected
        }
    }
}
