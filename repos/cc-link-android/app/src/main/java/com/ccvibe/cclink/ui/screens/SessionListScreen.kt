@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.ccvibe.cclink.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AddComment
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.ExperimentalMaterialApi
import androidx.compose.material.pullrefresh.PullRefreshIndicator
import androidx.compose.material.pullrefresh.pullRefresh
import androidx.compose.material.pullrefresh.rememberPullRefreshState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ccvibe.cclink.data.ActiveSession
import com.ccvibe.cclink.data.ConnectionState
import com.ccvibe.cclink.data.HistorySession
import com.ccvibe.cclink.data.SessionGroup
import com.ccvibe.cclink.ui.AppViewModel
import com.ccvibe.cclink.ui.ThemeMode
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterialApi::class)
@Composable
fun SessionListScreen(viewModel: AppViewModel) {
    val state by viewModel.sessions.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val theme by viewModel.theme.collectAsStateWithLifecycle()
    var showSettings by remember { mutableStateOf(false) }
    var showAddWorkspace by remember { mutableStateOf(false) }
    val pullRefreshState = rememberPullRefreshState(
        refreshing = state.refreshing,
        onRefresh = { viewModel.refreshSessions(userInitiated = true) },
    )

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("CCLink", fontWeight = FontWeight.Bold)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier
                                    .size(8.dp)
                                    .clip(CircleShape)
                                    .background(connectionColor(connection)),
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(connectionLabel(connection), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { viewModel.refreshSessions(userInitiated = true) }, modifier = Modifier.semantics { contentDescription = "刷新会话列表" }) {
                        Icon(Icons.Default.Refresh, "刷新")
                    }
                    IconButton(onClick = { showAddWorkspace = true }, modifier = Modifier.semantics { contentDescription = "添加工作目录" }) {
                        Icon(Icons.Default.Add, "添加工作目录")
                    }
                    IconButton(onClick = { showSettings = true }, modifier = Modifier.semantics { contentDescription = "打开设置" }) {
                        Icon(Icons.Default.Settings, "设置")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).pullRefresh(pullRefreshState)) {
            when {
                state.loading && state.groups.isEmpty() -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                state.groups.isEmpty() -> EmptySessions(
                    error = state.error,
                    onAdd = { showAddWorkspace = true },
                    onRetry = { viewModel.refreshSessions(userInitiated = true) },
                )
                else -> LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (state.refreshing) item { CircularProgressIndicator(Modifier.size(24.dp)) }
                    state.error?.let { error ->
                        item { Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                    }
                    items(state.groups, key = { it.workspace.path }) { group ->
                        DirectoryCard(
                            group = group,
                            expanded = group.workspace.path in state.expanded,
                            active = state.active,
                            onToggle = { viewModel.toggleDirectory(group.workspace.path) },
                            onNewChat = { viewModel.openChat(group.workspace.path, null) },
                            onOpenChat = { viewModel.openChat(group.workspace.path, it) },
                        )
                    }
                    item { Spacer(Modifier.height(24.dp)) }
                }
            }
            PullRefreshIndicator(
                refreshing = state.refreshing,
                state = pullRefreshState,
                modifier = Modifier.align(Alignment.TopCenter),
                contentColor = MaterialTheme.colorScheme.primary,
            )
        }
    }

    if (showAddWorkspace) {
        AddWorkspaceDialog(
            onDismiss = { showAddWorkspace = false },
            onAdd = { path, done -> viewModel.addWorkspace(path, done) },
        )
    }
    if (showSettings) {
        SettingsDialog(
            connection = connection,
            theme = theme,
            onTheme = viewModel::setTheme,
            onDisconnect = { showSettings = false; viewModel.disconnect() },
            onDismiss = { showSettings = false },
        )
    }
}

@Composable
private fun DirectoryCard(
    group: SessionGroup,
    expanded: Boolean,
    active: Map<String, ActiveSession>,
    onToggle: () -> Unit,
    onNewChat: () -> Unit,
    onOpenChat: (String) -> Unit,
) {
    Card(
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = CardDefaults.outlinedCardBorder(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onToggle)
                .semantics(mergeDescendants = true) { contentDescription = "${workspaceName(group.workspace.path)}，${group.sessions.size} 个会话，${if (expanded) "已展开" else "已折叠"}" }
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Folder, null, tint = MaterialTheme.colorScheme.primary)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(workspaceName(group.workspace.path), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(group.workspace.path, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${group.sessions.size} 个会话 · ${formatTime(group.latestAt)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (group.sessions.any { active[it.sessionId] != null }) {
                Box(Modifier.size(9.dp).clip(CircleShape).background(androidx.compose.ui.graphics.Color(0xFF42D276)))
                Spacer(Modifier.width(8.dp))
            }
            Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, if (expanded) "折叠" else "展开")
        }
        if (expanded) {
            Column(Modifier.padding(horizontal = 10.dp).padding(bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                FilledTonalButton(
                    onClick = onNewChat,
                    modifier = Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "在 ${workspaceName(group.workspace.path)} 中新建会话" },
                    shape = RoundedCornerShape(16.dp),
                ) {
                    Icon(Icons.Default.AddComment, null)
                    Spacer(Modifier.width(8.dp))
                    Text("新建会话")
                }
                group.sessions.forEach { session ->
                    SessionRow(session, active[session.sessionId], onClick = { onOpenChat(session.sessionId) })
                }
            }
        }
    }
}

@Composable
private fun SessionRow(session: HistorySession, active: ActiveSession?, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .semantics(mergeDescendants = true) {
                contentDescription = "${session.title?.takeIf { it.isNotBlank() } ?: "会话 ${session.sessionId.take(8)}"}，${session.messageCount} 条消息${active?.let { "，${it.status}" }.orEmpty()}"
            }
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f))
            .padding(13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                session.title?.takeIf { it.isNotBlank() } ?: "会话 ${session.sessionId.take(8)}…",
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${session.messageCount} 条消息 · ${formatTime(session.lastTimestamp)}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(session.sessionId.take(12) + "…", style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        active?.let {
            Text(
                when (it.status) { "starting" -> "启动中"; "running" -> "运行中"; else -> "可挂接" },
                color = MaterialTheme.colorScheme.primary,
                style = MaterialTheme.typography.labelMedium,
            )
        }
    }
}

@Composable
private fun EmptySessions(error: String?, onAdd: () -> Unit, onRetry: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Icon(Icons.Default.Folder, null, Modifier.size(54.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
        Text(if (error == null) "还没有会话" else "会话加载失败", style = MaterialTheme.typography.titleMedium)
        Text(error ?: "添加工作目录后即可开始新会话", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(18.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedButton(onClick = onRetry) { Text("重试") }
            Button(onClick = onAdd) { Text("添加目录") }
        }
    }
}

@Composable
private fun AddWorkspaceDialog(onDismiss: () -> Unit, onAdd: (String, (String?) -> Unit) -> Unit) {
    var path by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var submitting by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("添加工作目录") },
        text = {
            Column {
                Text("请输入 daemon 所在主机上的绝对路径。", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(value = path, onValueChange = { path = it; error = null }, label = { Text("目录路径") }, singleLine = true)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(enabled = path.isNotBlank() && !submitting, onClick = {
                submitting = true
                onAdd(path) { result ->
                    submitting = false
                    if (result == null) onDismiss() else error = result
                }
            }) { Text(if (submitting) "添加中…" else "添加") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}

@Composable
private fun SettingsDialog(
    connection: ConnectionState,
    theme: ThemeMode,
    onTheme: (ThemeMode) -> Unit,
    onDisconnect: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("设置") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(connectionLabel(connection), fontWeight = FontWeight.Medium)
                if (connection is ConnectionState.Connected) {
                    Text(connection.config.baseUrl, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                }
                Text("主题", style = MaterialTheme.typography.labelMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ThemeMode.entries.forEach { mode ->
                        OutlinedButton(onClick = { onTheme(mode) }, enabled = theme != mode) {
                            Text(when (mode) { ThemeMode.SYSTEM -> "系统"; ThemeMode.LIGHT -> "浅色"; ThemeMode.DARK -> "深色" })
                        }
                    }
                }
            }
        },
        confirmButton = { Button(onClick = onDisconnect) { Text("断开连接") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } },
    )
}

private fun workspaceName(path: String): String = path.trimEnd('/').substringAfterLast('/').ifBlank { path }

private fun formatTime(value: String?): String {
    if (value.isNullOrBlank()) return "暂无更新"
    return runCatching {
        DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(value))
    }.getOrDefault(value.take(16))
}

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.Disconnected -> "未连接"
    ConnectionState.Connecting -> "正在连接"
    is ConnectionState.Connected -> "已连接"
    is ConnectionState.Reconnecting -> "正在重连（${state.attempt}）"
    is ConnectionState.Failed -> state.message
}

private fun connectionColor(state: ConnectionState) = when (state) {
    is ConnectionState.Connected -> androidx.compose.ui.graphics.Color(0xFF42D276)
    is ConnectionState.Reconnecting, ConnectionState.Connecting -> androidx.compose.ui.graphics.Color(0xFFFFB74D)
    else -> androidx.compose.ui.graphics.Color(0xFFFF6B72)
}
