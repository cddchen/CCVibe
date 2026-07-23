package com.ccvibe.cclink.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.ccvibe.cclink.ui.ThemeMode

private val DarkColors = darkColorScheme(
    primary = Color(0xFF8B7CFF),
    onPrimary = Color.White,
    secondary = Color(0xFF6EA8FF),
    background = Color(0xFF090B13),
    surface = Color(0xFF111520),
    surfaceVariant = Color(0xFF1A1F2D),
    onSurface = Color(0xFFF2F3FA),
    onSurfaceVariant = Color(0xFFB8BDCC),
    outline = Color(0xFF343A4B),
    error = Color(0xFFFF6B72),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF6554D9),
    secondary = Color(0xFF3569B7),
    background = Color(0xFFF6F7FB),
    surface = Color.White,
    surfaceVariant = Color(0xFFEDEEF5),
    onSurface = Color(0xFF181A22),
    onSurfaceVariant = Color(0xFF5D6170),
    outline = Color(0xFFD2D5E0),
    error = Color(0xFFBA1A1A),
)

@Composable
fun CCLinkTheme(mode: ThemeMode, content: @Composable () -> Unit) {
    val dark = when (mode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.DARK -> true
        ThemeMode.LIGHT -> false
    }
    MaterialTheme(colorScheme = if (dark) DarkColors else LightColors, content = content)
}
