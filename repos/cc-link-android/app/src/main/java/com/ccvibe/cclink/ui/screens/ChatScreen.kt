@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.ccvibe.cclink.ui.screens

import android.graphics.Color as AndroidColor
import android.graphics.Typeface
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
import androidx.compose.foundation.layout.wrapContentWidth
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
import androidx.core.content.res.ResourcesCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.ccvibe.cclink.R
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
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.core.MarkwonTheme
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
    if (message.role == MessageRole.SYSTEM) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.65f),
                shape = RoundedCornerShape(14.dp),
            ) {
                Text(
                    message.userText.orEmpty(),
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        return
    }
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

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Surface(
            modifier = Modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
            shape = RoundedCornerShape(22.dp, 22.dp, 22.dp, 5.dp),
        ) {
            AssistantMessageBody(message, toolResults, Modifier.padding(15.dp))
        }
        message.error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
        }
        assistantMetadata(message).takeIf { it.isNotEmpty() }?.let { metadata ->
            Text(
                metadata.joinToString(" · "),
                modifier = Modifier.padding(horizontal = 5.dp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun AssistantMessageBody(
    message: ChatMessage,
    toolResults: Map<String, ToolResult>,
    modifier: Modifier = Modifier,
) {
    val processBlocks = message.blocks.filter { it is MessageBlock.Thinking || it is MessageBlock.ToolUse }
    val textBlocks = message.blocks.filterIsInstance<MessageBlock.Text>().filter { it.text.isNotBlank() }

    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (message.blocks.isEmpty() && message.streaming) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(9.dp))
                Text("CCLink 思考中…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (processBlocks.isNotEmpty()) {
            ProcessGroup(
                messageId = message.id,
                blocks = processBlocks,
                toolResults = toolResults,
                streaming = message.streaming,
            )
        }
        textBlocks.forEach { MarkdownText(it.text) }
        if (message.streaming && textBlocks.isEmpty() && processBlocks.isNotEmpty()) {
            Text("正在处理…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun ProcessGroup(
    messageId: String,
    blocks: List<MessageBlock>,
    toolResults: Map<String, ToolResult>,
    streaming: Boolean,
) {
    var userExpanded by remember(messageId) { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(streaming) {
        if (!streaming) userExpanded = null
    }
    val expanded = userExpanded ?: streaming
    val thinkingCount = blocks.count { it is MessageBlock.Thinking }
    val toolCount = blocks.count { it is MessageBlock.ToolUse }
    val summary = buildList {
        if (thinkingCount > 0) add("$thinkingCount 思考")
        if (toolCount > 0) add("$toolCount 工具")
    }.joinToString(" · ")

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.72f)),
        shape = RoundedCornerShape(18.dp),
        border = CardDefaults.outlinedCardBorder(),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { userExpanded = !expanded }.padding(13.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(9.dp),
            ) {
                if (streaming) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                } else {
                    Icon(Icons.Default.CheckCircle, null, tint = Color(0xFF42B96B), modifier = Modifier.size(18.dp))
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        if (streaming) "过程 · 进行中" else "过程",
                        fontWeight = FontWeight.SemiBold,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (summary.isNotEmpty()) {
                        Text(summary, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Icon(if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore, null)
            }
            if (expanded) {
                HorizontalDivider()
                Column(
                    Modifier.fillMaxWidth().padding(11.dp),
                    verticalArrangement = Arrangement.spacedBy(9.dp),
                ) {
                    blocks.forEach { block ->
                        when (block) {
                            is MessageBlock.Thinking -> ThinkingCard(block.text, streaming)
                            is MessageBlock.ToolUse -> ToolCard(block, toolResults[block.id], streaming)
                            is MessageBlock.Text -> Unit
                        }
                    }
                }
            }
        }
    }
}

private fun assistantMetadata(message: ChatMessage): List<String> = listOfNotNull(
    message.model,
    message.metrics?.elapsedSeconds?.let { seconds ->
        if (seconds % 1.0 == 0.0) "${seconds.toLong()}s" else "${"%.1f".format(seconds)}s"
    },
    message.metrics?.let { metrics ->
        val total = (metrics.inputTokens ?: 0) + (metrics.outputTokens ?: 0)
        total.takeIf { it > 0 }?.let { "$it tokens" }
    },
)

private sealed interface MarkdownSegment {
    data class Wrapping(val content: String) : MarkdownSegment
    data class Code(val content: String) : MarkdownSegment
    data class Table(val rows: List<List<String>>) : MarkdownSegment
}

@Composable
private fun MarkdownText(markdown: String) {
    val context = LocalContext.current
    val color = MaterialTheme.colorScheme.onSurface.toArgb()
    val linkColor = MaterialTheme.colorScheme.primary.toArgb()
    val wideBackground = MaterialTheme.colorScheme.surface
    val segments = remember(markdown) { splitMarkdownSegments(markdown) }
    val codeTypeface = remember(context) {
        checkNotNull(ResourcesCompat.getFont(context, R.font.jetbrains_mono_regular)) {
            "Bundled JetBrains Mono font is unavailable"
        }
    }
    val markwon = remember(context) {
        Markwon.builder(context)
            .usePlugin(CoilImagesPlugin.create(context))
            .usePlugin(TablePlugin.create(context))
            .usePlugin(StrikethroughPlugin.create())
            .usePlugin(object : AbstractMarkwonPlugin() {
                override fun configureTheme(builder: MarkwonTheme.Builder) {
                    // Markwon treats color value 0 as "not configured" and restores its gray default.
                    val transparentCodeBackground = AndroidColor.argb(1, 0, 0, 0)
                    builder
                        .codeBackgroundColor(transparentCodeBackground)
                        .codeBlockBackgroundColor(transparentCodeBackground)
                        .codeTypeface(codeTypeface)
                        .codeBlockTypeface(codeTypeface)
                }
            })
            .build()
    }

    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(7.dp)) {
        segments.forEach { segment ->
            when (segment) {
                is MarkdownSegment.Wrapping -> MarkdownAndroidText(
                    markdown = segment.content,
                    markwon = markwon,
                    color = color,
                    linkColor = linkColor,
                    horizontallyScrollable = false,
                    typeface = null,
                    modifier = Modifier.fillMaxWidth(),
                )
                is MarkdownSegment.Code -> Box(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(wideBackground),
                ) {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                        MarkdownAndroidText(
                            markdown = segment.content,
                            markwon = markwon,
                            color = color,
                            linkColor = linkColor,
                            horizontallyScrollable = true,
                            typeface = codeTypeface,
                            modifier = Modifier.wrapContentWidth(unbounded = true).padding(4.dp),
                        )
                    }
                }
                is MarkdownSegment.Table -> Box(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(wideBackground),
                ) {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
                        MarkdownTable(segment.rows)
                    }
                }
            }
        }
    }
}

@Composable
private fun MarkdownTable(rows: List<List<String>>) {
    val columnCount = rows.maxOfOrNull(List<String>::size) ?: return
    val columnWidths = remember(rows) {
        (0 until columnCount).map { column ->
            val longest = rows.maxOfOrNull { row -> row.getOrNull(column)?.visualLength() ?: 0 } ?: 0
            (longest * 8 + 28).coerceIn(112, 260).dp
        }
    }
    val dividerColor = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.75f)
    val headerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f)

    Column {
        rows.forEachIndexed { rowIndex, row ->
            Row(Modifier.background(if (rowIndex == 0) headerColor else Color.Transparent)) {
                repeat(columnCount) { column ->
                    Text(
                        text = row.getOrNull(column).orEmpty().toDisplayMarkdownCell(),
                        modifier = Modifier.width(columnWidths[column]).padding(horizontal = 11.dp, vertical = 9.dp),
                        fontWeight = if (rowIndex == 0) FontWeight.SemiBold else FontWeight.Normal,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            if (rowIndex != rows.lastIndex) HorizontalDivider(color = dividerColor)
        }
    }
}

@Composable
private fun MarkdownAndroidText(
    markdown: String,
    markwon: Markwon,
    color: Int,
    linkColor: Int,
    horizontallyScrollable: Boolean,
    typeface: Typeface?,
    modifier: Modifier,
) {
    AndroidView(
        factory = {
            TextView(it).apply {
                setTextIsSelectable(true)
                movementMethod = LinkMovementMethod.getInstance()
                textSize = 14f
                setLineSpacing(0f, 1.16f)
                setBackgroundColor(AndroidColor.TRANSPARENT)
            }
        },
        update = { view ->
            view.setTextColor(color)
            view.setLinkTextColor(linkColor)
            view.setHorizontallyScrolling(horizontallyScrollable)
            view.typeface = typeface ?: Typeface.DEFAULT
            markwon.setMarkdown(view, markdown)
        },
        modifier = modifier,
    )
}

private fun splitMarkdownSegments(markdown: String): List<MarkdownSegment> {
    val lines = markdown.lines()
    val result = mutableListOf<MarkdownSegment>()
    val wrapping = mutableListOf<String>()

    fun flushWrapping() {
        if (wrapping.isEmpty()) return
        wrapping.joinToString("\n").trim('\n').takeIf(String::isNotEmpty)?.let {
            result += MarkdownSegment.Wrapping(it)
        }
        wrapping.clear()
    }

    var index = 0
    while (index < lines.size) {
        val trimmed = lines[index].trimStart()
        val fence = when {
            trimmed.startsWith("```") -> "```"
            trimmed.startsWith("~~~") -> "~~~"
            else -> null
        }
        val isTable = index + 1 < lines.size && lines[index].contains('|') && isMarkdownTableDivider(lines[index + 1])
        if (fence != null) {
            flushWrapping()
            val block = mutableListOf(lines[index++])
            while (index < lines.size) {
                block += lines[index]
                if (lines[index].trimStart().startsWith(fence)) {
                    index += 1
                    break
                }
                index += 1
            }
            result += MarkdownSegment.Code(block.joinToString("\n"))
        } else if (isTable) {
            flushWrapping()
            val block = mutableListOf<String>()
            while (index < lines.size && lines[index].isNotBlank() && lines[index].contains('|')) {
                block += lines[index++]
            }
            val rows = block.map(::splitMarkdownTableRow).filterIndexed { rowIndex, _ -> rowIndex != 1 }
            if (rows.isNotEmpty()) result += MarkdownSegment.Table(rows)
        } else {
            wrapping += lines[index++]
        }
    }
    flushWrapping()
    return result.ifEmpty { listOf(MarkdownSegment.Wrapping(markdown)) }
}

private fun splitMarkdownTableRow(line: String): List<String> {
    val content = line.trim().removePrefix("|").removeSuffix("|")
    val cells = mutableListOf<String>()
    val current = StringBuilder()
    var escaped = false
    content.forEach { char ->
        when {
            escaped -> {
                current.append(char)
                escaped = false
            }
            char == '\\' -> escaped = true
            char == '|' -> {
                cells += current.toString().trim()
                current.clear()
            }
            else -> current.append(char)
        }
    }
    if (escaped) current.append('\\')
    cells += current.toString().trim()
    return cells
}

private fun String.visualLength(): Int = fold(0) { length, char -> length + if (char.code > 0xFF) 2 else 1 }

private fun String.toDisplayMarkdownCell(): String = this
    .replace(Regex("!\\[([^]]*)]\\([^)]+\\)"), "\$1")
    .replace(Regex("\\[([^]]+)]\\([^)]+\\)"), "\$1")
    .replace("<br>", "\n", ignoreCase = true)
    .replace("**", "")
    .replace("__", "")
    .replace("`", "")

private fun isMarkdownTableDivider(line: String): Boolean {
    val cells = line.trim().trim('|').split('|')
    return cells.isNotEmpty() && cells.all { cell ->
        cell.trim().matches(Regex(":?-{3,}:?"))
    }
}

@Composable
private fun ThinkingCard(text: String, streaming: Boolean) {
    var userExpanded by remember { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(streaming) {
        if (!streaming) userExpanded = null
    }
    val expanded = userExpanded ?: streaming
    Card(
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f)),
        shape = RoundedCornerShape(18.dp),
    ) {
        Column {
            Row(Modifier.fillMaxWidth().clickable { userExpanded = !expanded }.padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (streaming) "思考过程 · 进行中" else "思考过程", Modifier.weight(1f), color = MaterialTheme.colorScheme.secondary, fontWeight = FontWeight.Medium)
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
private fun ToolCard(block: MessageBlock.ToolUse, result: ToolResult?, streaming: Boolean) {
    var userExpanded by remember(block.id) { mutableStateOf<Boolean?>(null) }
    LaunchedEffect(streaming) {
        if (!streaming) userExpanded = null
    }
    val expanded = userExpanded ?: streaming
    val status = result?.status ?: ToolStatus.RUNNING
    val statusColor = when (status) {
        ToolStatus.SUCCESS -> Color(0xFF42D276)
        ToolStatus.FAILED, ToolStatus.DENIED -> MaterialTheme.colorScheme.error
        ToolStatus.WAITING_PERMISSION -> Color(0xFFFFB74D)
        ToolStatus.RUNNING -> MaterialTheme.colorScheme.secondary
    }
    Card(shape = RoundedCornerShape(20.dp), border = CardDefaults.outlinedCardBorder()) {
        Column {
            Row(Modifier.fillMaxWidth().clickable { userExpanded = !expanded }.padding(13.dp), verticalAlignment = Alignment.CenterVertically) {
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
