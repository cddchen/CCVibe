package com.ccvibe.cclink.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ccvibe.cclink.ui.screens.ChatScreen
import com.ccvibe.cclink.ui.screens.LoginScreen
import com.ccvibe.cclink.ui.screens.SessionListScreen
import com.ccvibe.cclink.ui.theme.CCLinkTheme

@Composable
fun CCLinkApp(viewModel: AppViewModel) {
    val screen by viewModel.screen.collectAsStateWithLifecycle()
    val theme by viewModel.theme.collectAsStateWithLifecycle()
    val lifecycleOwner = LocalLifecycleOwner.current

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_START) viewModel.onForeground()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    CCLinkTheme(theme) {
        when (screen) {
            AppScreen.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            AppScreen.Login -> LoginScreen(viewModel)
            AppScreen.Sessions -> SessionListScreen(viewModel)
            AppScreen.Chat -> {
                BackHandler { viewModel.returnToSessions() }
                ChatScreen(viewModel)
            }
        }
    }
}
