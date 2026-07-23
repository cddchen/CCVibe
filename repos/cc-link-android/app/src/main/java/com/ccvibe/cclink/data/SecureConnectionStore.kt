package com.ccvibe.cclink.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.nio.ByteBuffer
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class SecureConnectionStore(context: Context) {
    private val preferences = context.getSharedPreferences("cc_link_preferences", Context.MODE_PRIVATE)

    fun readConnection(): ConnectionConfig? {
        val host = preferences.getString(KEY_HOST, null)?.takeIf { it.isNotBlank() } ?: return null
        val token = decrypt(preferences.getString(KEY_TOKEN, null))?.takeIf { it.isNotBlank() } ?: return null
        return ConnectionConfig(
            host = host,
            port = preferences.getInt(KEY_PORT, 4733),
            useTls = preferences.getBoolean(KEY_TLS, false),
            token = token,
            path = preferences.getString(KEY_PATH, "/ws") ?: "/ws",
        )
    }

    fun saveConnection(config: ConnectionConfig) {
        preferences.edit()
            .putString(KEY_HOST, config.host)
            .putInt(KEY_PORT, config.port)
            .putBoolean(KEY_TLS, config.useTls)
            .putString(KEY_PATH, config.path)
            .putString(KEY_TOKEN, encrypt(config.token))
            .apply()
    }

    fun readExpandedDirectories(): Set<String> =
        preferences.getStringSet(KEY_EXPANDED, emptySet())?.toSet().orEmpty()

    fun saveExpandedDirectories(paths: Set<String>) {
        preferences.edit().putStringSet(KEY_EXPANDED, paths).apply()
    }

    fun readTheme(): String = preferences.getString(KEY_THEME, "system") ?: "system"

    fun saveTheme(theme: String) {
        preferences.edit().putString(KEY_THEME, theme).apply()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val packed = ByteBuffer.allocate(4 + cipher.iv.size + encrypted.size)
            .putInt(cipher.iv.size)
            .put(cipher.iv)
            .put(encrypted)
            .array()
        return Base64.encodeToString(packed, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String?): String? {
        if (encoded.isNullOrBlank()) return null
        return runCatching {
            val packed = ByteBuffer.wrap(Base64.decode(encoded, Base64.NO_WRAP))
            val ivSize = packed.int
            require(ivSize in 12..32)
            val iv = ByteArray(ivSize).also(packed::get)
            val encrypted = ByteArray(packed.remaining()).also(packed::get)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(encrypted), Charsets.UTF_8)
        }.getOrNull()
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEY_ALIAS = "cc_link_connection_token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val KEY_HOST = "connection_host"
        const val KEY_PORT = "connection_port"
        const val KEY_TLS = "connection_tls"
        const val KEY_PATH = "connection_path"
        const val KEY_TOKEN = "connection_token"
        const val KEY_EXPANDED = "expanded_directories"
        const val KEY_THEME = "theme"
    }
}
