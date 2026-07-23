package com.ccvibe.cclink.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ccvibe.cclink.ui.AppViewModel

@Composable
fun LoginScreen(viewModel: AppViewModel) {
    val state by viewModel.login.collectAsStateWithLifecycle()
    var showToken by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 22.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.primary, RoundedCornerShape(24.dp))
                    .padding(horizontal = 25.dp, vertical = 16.dp),
            ) {
                Text("C", style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Black)
            }
            Spacer(Modifier.height(18.dp))
            Text("CCLink", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text("连接你的 CC Agent daemon", color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(28.dp))

            Card(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(28.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            ) {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    OutlinedTextField(
                        value = state.host,
                        onValueChange = viewModel::updateLoginHost,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("主机或 WebSocket 地址") },
                        placeholder = { Text("192.168.1.10 或 ws://host:4733") },
                        singleLine = true,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = state.port,
                            onValueChange = viewModel::updateLoginPort,
                            modifier = Modifier.weight(1f),
                            label = { Text("端口") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        )
                        Spacer(Modifier.width(18.dp))
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text("TLS", style = MaterialTheme.typography.labelMedium)
                            Switch(checked = state.useTls, onCheckedChange = viewModel::updateLoginTls)
                        }
                    }
                    OutlinedTextField(
                        value = state.token,
                        onValueChange = viewModel::updateLoginToken,
                        modifier = Modifier.fillMaxWidth(),
                        label = { Text("Token") },
                        singleLine = true,
                        visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
                        trailingIcon = {
                            IconButton(onClick = { showToken = !showToken }) {
                                Icon(if (showToken) Icons.Default.VisibilityOff else Icons.Default.Visibility, null)
                            }
                        },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { viewModel.submitLogin() }),
                    )
                    state.error?.let {
                        Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    Button(
                        onClick = viewModel::submitLogin,
                        enabled = !state.connecting && state.host.isNotBlank() && state.token.isNotBlank(),
                        modifier = Modifier.fillMaxWidth().height(52.dp),
                        shape = RoundedCornerShape(18.dp),
                    ) {
                        if (state.connecting) {
                            CircularProgressIndicator(Modifier.width(22.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                            Spacer(Modifier.width(10.dp))
                            Text("连接并校验…")
                        } else {
                            Text("登录")
                        }
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
            Text(
                "手机需要使用 Mac 的局域网 IP，不能使用 127.0.0.1",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
