@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.ccvibe.cclink.ui.screens

import android.graphics.Color as AndroidColor
import android.text.method.LinkMovementMethod
import android.widget.TextView
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ccvibe.cclink.data.AskQuestion
import com.ccvibe.cclink.data.ChatMessage
import com.ccvibe.cclink.data.ChatState
import com.ccvibe.cclink.data.ConnectionState
import com.ccvibe.cclink.data.Effort
import com.ccvibe.cclink.data.MessageBlock
import com.ccvibe.cclink.data.MessageRole
import com.ccvibe.cclink.data.ModelOption
import com.ccvibe.cclink.data.PermissionMode
import com.ccvibe.cclink.data.PermissionRequest
import com.ccvibe.cclink.data.ToolResult
import com.ccvibe.cclink.data.ToolStatus
import com.ccvibe.cclink.data.boolean
import com.ccvibe.cclink.data.string
import com.ccvibe.cclink.ui.AppViewModel
import io.noties.markwon.Markwon
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.image.coil.CoilImagesPlugin
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Composable
fun ChatScreen(viewModel: AppViewModel) {
    val state by viewModel.chat.collectAsStateWithLifecycle()
    val models by viewModel.models.collectAsStateWithLifecycle()
    val connection by viewModel.connection.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    val isDragged by listState.interactionSource.collectIsDraggedAsState()
    var followOutput by remember { mutableStateOf(true) }
    val atBottom by remember {
        derivedStateOf {
            val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0
            last >= listState.layoutInfo.totalItemsCount - 2
        }
    }

    LaunchedEffect(state.messages.size, state.messages.lastOrNull()?.blocks?.hashCode(), followOutput) {
        if (followOutput && state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }
    LaunchedEffect(isDragged, atBottom) {
        if (isDragged && !atBottom) followOutput = false
        if (atBottom) followOutput = true
    }

    Scaffold(
        modifier = Modifier.imePadding(),
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = viewModel::returnToSessions) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
                title = {
                    Column {
                        Text(state.title, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Bold)
                        Text(
                            workspaceName(state.workspacePath) + (state.runStatus?.let { " · $it" } ?: ""),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        bottomBar = {
            Composer(
                state = state,
                models = models,
                connected = connection is ConnectionState.Connected,
                onDraft = viewModel::updateDraft,
                onModel = viewModel::selectModel,
                onEffort = viewModel::selectEffort,
                onPermission = viewModel::selectPermissionMode,
                onSend = viewModel::sendMessage,
                onStop = viewModel::stop,
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (state.loading && state.messages.isEmpty()) {
                CircularProgressIndicator(Modifier.align(Alignment.Center))
            } else if (state.messages.isEmpty()) {
                EmptyChat(state.workspacePath)
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 14.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    items(state.messages, key = { it.id }) { message ->
                        MessageRow(message, state.toolResults)
                    }
                    item { Spacer(Modifier.height(12.dp)) }
                }
            }
            state.error?.let { error ->
                Surface(
                    modifier = Modifier.align(Alignment.TopCenter).padding(12.dp),
                    color = MaterialTheme.colorScheme.errorContainer,
                    shape = RoundedCornerShape(14.dp),
                ) {
                    Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(error, Modifier.weight(1f), color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = viewModel::retryLastMessage) { Text("重试发送") }
                        IconButton(onClick = viewModel::retryCurrentChat) { Icon(Icons.Default.Refresh, "重新加载") }
                    }
                }
            }
            if (!followOutput && state.messages.isNotEmpty()) {
                FilledTonalButton(
                    onClick = {
                        followOutput = true
                    },
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
                ) { Text("回到最新消息") }
            }
        }
    }

    state.trustPath?.let { path ->
        TrustDialog(
            path = path,
            parent = state.trustParent,
            onTrust = viewModel::trustWorkspace,
            onCancel = viewModel::returnToSessions,
        )
    }
    state.pendingPermission?.let { request ->
        if (request.toolName == "AskUserQuestion") {
            AskUserQuestionDialog(request, viewModel::respondAskQuestion)
        } else {
            PermissionDialog(request, viewModel::respondPermission)
        }
    }
}

@Composable
private fun EmptyChat(path: String) {
    Column(Modifier.fillMaxSize().padding(36.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Box(Modifier.size(72.dp).clip(RoundedCornerShape(24.dp)).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
            Text("C", style = MaterialTheme.typography.headlineLarge, color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Black)
        }
        Spacer(Modifier.height(18.dp))
        Text("开始新的会话", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(workspaceName(path), color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun MessageRow(message: ChatMessage, toolResults: Map<String, ToolResult>) {
    if (message.role == MessageRole.USER) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(
                modifier = Modifier.fillMaxWidth(0.88f),
                color = MaterialTheme.colorScheme.primaryContainer,
                shape = RoundedCornerShape(22.dp, 22.dp, 5.dp, 22.dp),
            ) {
                SelectionContainer {
                    Text(message.userText.orEmpty(), Modifier.padding(15.dp), color = MaterialTheme.colorScheme.onPrimaryContainer)
                }
            }
        }
        return
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (message.blocks.isEmpty() && message.streaming) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(9.dp))
                Text("CCLink 思考中…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        message.blocks.forEach { block ->
            when (block) {
                is MessageBlock.Text -> MarkdownText(block.text)
                is MessageBlock.Thinking -> ThinkingCard(block.text, message.streaming)
                is MessageBlock.ToolUse -> ToolCard(block, toolResults[block.id])
            }
        }
        message.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        val metadata = listOfNotNull(
            message.model,
            message.metrics?.elapsedSeconds?.let { "${it}s" },
            message.metrics?.let { metrics ->
                val total = (metrics.inputTokens ?: 0) + (metrics.outputTokens ?: 0)
                total.takeIf { it > 0 }?.let { "$it tokens" }
            },
        )
        if (metadata.isNotEmpty()) {
            Text(metadata.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun MarkdownText(markdown: String) {
    val context = LocalContext.current
    val color = MaterialTheme.colorScheme.onSurface.toArgb()
    val linkColor = MaterialTheme.colorScheme.primary.toArgb()
    val markwon = remember(context) {
        Markwon.builder(context)
            .usePlugin(CoilImagesPlugin.create(context))
            .usePlugin(TablePlugin.create(context))
            .usePlugin(StrikethroughPlugin.create())
            .build()
    }
    AndroidView(
        factory = {
            TextView(it).apply {
                setTextIsSelectable(true)
                movementMethod = LinkMovementMethod.getInstance()
                textSize = 14f
                setLineSpacing(0f, 1.16f)
                setLinkTextColor(linkColor)
                setBackgroundColor(AndroidColor.TRANSPARENT)
            }
        },
        update = { view ->
            view.setTextColor(color)
            view.setLinkTextColor(linkColor)
            markwon.setMarkdown(view, markdown)
        },
        modifier = if (markdown.contains("```") || markdown.lines().count { it.count { char -> char == '|' } >= 2 } >= 2) {
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())
        } else {
            Modifier.fillMaxWidth()
        },
    )
}

@Composable
private fun ThinkingCard(text: String, streaming: Boolean) {
    var expanded by remember(text, streaming) { mutableStateOf(streaming) }
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)),
        shape = RoundedCornerShape(18.dp),
    ) {
        Column {
            Row(Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (streaming) "思考中…" else "思考过程", Modifier.weight(1f), color = MaterialTheme.colorScheme.secondary, fontWeight = FontWeight.Medium)
                Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null)
            }
            if (expanded) {
                HorizontalDivider()
                Text(text, Modifier.padding(13.dp), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun ToolCard(block: MessageBlock.ToolUse, result: ToolResult?) {
    var expanded by remember(block.id) { mutableStateOf(false) }
    val status = result?.status ?: ToolStatus.RUNNING
    val statusColor = when (status) {
        ToolStatus.SUCCESS -> Color(0xFF42D276)
        ToolStatus.FAILED, ToolStatus.DENIED -> MaterialTheme.colorScheme.error
        ToolStatus.WAITING_PERMISSION -> Color(0xFFFFB74D)
        ToolStatus.RUNNING -> MaterialTheme.colorScheme.secondary
    }
    Card(shape = RoundedCornerShape(20.dp), border = CardDefaults.outlinedCardBorder()) {
        Column {
            Row(Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(if (status == ToolStatus.SUCCESS) Icons.Default.CheckCircle else Icons.Default.PlayArrow, null, tint = statusColor)
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(block.name, fontWeight = FontWeight.SemiBold)
                    Text(toolSummary(block), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(toolStatusLabel(status), color = statusColor, style = MaterialTheme.typography.labelMedium)
                Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null)
            }
            if (expanded) {
                HorizontalDivider()
                Column(Modifier.padding(13.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("INPUT", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(block.input.toString(), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
                    if (!result?.content.isNullOrBlank()) {
                        Text("RESULT", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(result?.content.orEmpty(), fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall, color = if (result?.isError == true) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
        }
    }
}

@Composable
private fun Composer(
    state: ChatState,
    models: List<ModelOption>,
    connected: Boolean,
    onDraft: (String) -> Unit,
    onModel: (String) -> Unit,
    onEffort: (Effort) -> Unit,
    onPermission: (PermissionMode) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.background, tonalElevation = 4.dp) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 9.dp)) {
            Card(
                shape = RoundedCornerShape(26.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                border = CardDefaults.outlinedCardBorder(),
            ) {
                Column(Modifier.padding(12.dp)) {
                    OutlinedTextField(
                        value = state.draft,
                        onValueChange = onDraft,
                        placeholder = { Text("输入消息或指令…") },
                        minLines = 1,
                        maxLines = 3,
                        enabled = connected,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default),
                        keyboardActions = KeyboardActions(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .onPreviewKeyEvent { event ->
                                if (event.key == Key.Enter && event.type == KeyEventType.KeyDown && !event.isShiftPressed) {
                                    onSend()
                                    true
                                } else {
                                    false
                                }
                            },
                    )
                    Spacer(Modifier.height(8.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Row(
                            Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            SelectionMenu(
                                label = models.firstOrNull { it.id == state.selectedModel }?.label ?: state.selectedModel,
                                enabled = connected && !state.busy,
                                entries = models.map { it.id to it.label },
                                onSelected = onModel,
                            )
                            SelectionMenu(
                                label = state.effort.label,
                                enabled = connected && !state.busy,
                                entries = Effort.entries.map { it.rpcValue to it.label },
                                onSelected = { value -> onEffort(Effort.fromRpc(value)) },
                            )
                            SelectionMenu(
                                label = state.permissionMode.label,
                                enabled = connected && !state.busy,
                                entries = PermissionMode.entries.map { it.rpcValue to it.label },
                                onSelected = { value -> onPermission(PermissionMode.fromRpc(value)) },
                            )
                        }
                        Spacer(Modifier.width(8.dp))
                        if (state.busy) {
                            FilledIconButton(onClick = onStop, enabled = connected, colors = androidx.compose.material3.IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
                                Icon(Icons.Default.Stop, "停止", tint = MaterialTheme.colorScheme.error)
                            }
                        } else {
                            FilledIconButton(onClick = onSend, enabled = connected && state.trusted && state.draft.isNotBlank()) {
                                Icon(Icons.AutoMirrored.Filled.Send, "发送")
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SelectionMenu(label: String, enabled: Boolean, entries: List<Pair<String, String>>, onSelected: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        FilledTonalButton(onClick = { expanded = true }, enabled = enabled, shape = RoundedCornerShape(20.dp)) { Text(label, maxLines = 1) }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            entries.forEach { (value, title) ->
                DropdownMenuItem(text = { Text(title) }, onClick = { expanded = false; onSelected(value) })
            }
        }
    }
}

@Composable
private fun TrustDialog(path: String, parent: String?, onTrust: (String) -> Unit, onCancel: () -> Unit) {
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("信任此工作目录？") },
        text = {
            Column {
                Text("信任后 App 才能读取历史并创建会话。")
                Spacer(Modifier.height(8.dp))
                Text(path, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = { Button(onClick = { onTrust(path) }) { Text("信任此目录") } },
        dismissButton = {
            Row {
                parent?.let { TextButton(onClick = { onTrust(it) }) { Text("信任父目录") } }
                TextButton(onClick = onCancel) { Text("取消") }
            }
        },
    )
}

@Composable
private fun PermissionDialog(request: PermissionRequest, onRespond: (Boolean, String, String) -> Unit) {
    var input by remember(request.requestId) { mutableStateOf(request.input.toString()) }
    var denyMessage by remember(request.requestId) { mutableStateOf("用户拒绝") }
    AlertDialog(
        onDismissRequest = { onRespond(false, input, denyMessage) },
        title = { Text("工具权限") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(request.toolName, fontWeight = FontWeight.Bold)
                OutlinedTextField(value = input, onValueChange = { input = it }, label = { Text("允许时的工具输入 JSON") }, minLines = 4, maxLines = 9, textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                OutlinedTextField(value = denyMessage, onValueChange = { denyMessage = it }, label = { Text("拒绝原因") }, singleLine = true)
            }
        },
        confirmButton = { Button(onClick = { onRespond(true, input, denyMessage) }) { Text("允许") } },
        dismissButton = { OutlinedButton(onClick = { onRespond(false, input, denyMessage) }) { Text("拒绝") } },
    )
}

@Composable
private fun AskUserQuestionDialog(request: PermissionRequest, onRespond: (JsonObject?) -> Unit) {
    val questions = remember(request.requestId) { parseQuestions(request.input) }
    val selected = remember(request.requestId) { mutableStateMapOf<Int, Set<String>>() }
    AlertDialog(
        onDismissRequest = { onRespond(null) },
        title = { Text("需要你的回答") },
        text = {
            Column(Modifier.heightIn(max = 520.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                questions.forEachIndexed { index, question ->
                    Column {
                        Text(question.header.ifBlank { "问题 ${index + 1}" }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        Text(question.question, fontWeight = FontWeight.Medium)
                        question.options.forEach { option ->
                            val checked = option in selected[index].orEmpty()
                            Row(
                                Modifier.fillMaxWidth().clickable {
                                    val current = selected[index].orEmpty()
                                    selected[index] = if (question.multiSelect) {
                                        if (checked) current - option else current + option
                                    } else setOf(option)
                                },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                if (question.multiSelect) Checkbox(checked, null) else RadioButton(checked, null)
                                Text(option)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                enabled = questions.isNotEmpty() && questions.indices.all { selected[it].orEmpty().isNotEmpty() },
                onClick = {
                    onRespond(buildJsonObject {
                        questions.forEachIndexed { index, question ->
                            put(question.question, selected[index].orEmpty().joinToString(", "))
                        }
                    })
                },
            ) { Text("提交") }
        },
        dismissButton = { TextButton(onClick = { onRespond(null) }) { Text("取消") } },
    )
}

private fun parseQuestions(input: JsonObject): List<AskQuestion> {
    val array = input["questions"] as? JsonArray ?: return emptyList()
    return array.mapNotNull { element ->
        val row = element as? JsonObject ?: return@mapNotNull null
        val question = row.string("question") ?: return@mapNotNull null
        val options = (row["options"] as? JsonArray).orEmpty().mapNotNull { option ->
            when (option) {
                is JsonPrimitive -> option.content
                is JsonObject -> option.string("label")
                else -> null
            }
        }
        AskQuestion(question, row.string("header").orEmpty(), options, row.boolean("multiSelect"))
    }
}

private fun toolSummary(block: MessageBlock.ToolUse): String {
    val keys = listOf("file_path", "command", "pattern", "query", "url")
    return keys.firstNotNullOfOrNull { block.input.string(it) } ?: block.input.toString().take(100)
}

private fun toolStatusLabel(status: ToolStatus): String = when (status) {
    ToolStatus.WAITING_PERMISSION -> "等待权限"
    ToolStatus.RUNNING -> "运行中"
    ToolStatus.SUCCESS -> "完成"
    ToolStatus.FAILED -> "失败"
    ToolStatus.DENIED -> "已拒绝"
}

private fun workspaceName(path: String): String = path.trimEnd('/').substringAfterLast('/').ifBlank { path }
