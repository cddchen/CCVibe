import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  AccessibilityInfo,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput as NativeTextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityIndicator, Button, IconButton, Menu, Text, useTheme, type MD3Theme } from 'react-native-paper';

import { GlassPanel } from '../../ui/glass/GlassPanel';
import { MaterialSurface } from '../../ui/material/MaterialSurface';
import { useCloudActions, useCloudSelector } from '../runtime/CloudRuntimeProvider';
import { selectRootCatalog, type CloudRuntimeState } from '../runtime/runtimeStore';
import {
  buildStructuredInputAnswers,
  selectChatViewModel,
  type ChatPartViewModel,
  type ChatViewModel,
  type ChatTranscriptItem,
  type PendingApprovalViewModel,
  type PendingInputViewModel,
} from './chatSelectors';
import { parseChatUri, type ChatUri } from '../../protocol/resourceUri';
import type { HostSlashCommand } from '../../protocol/hostWire';

export interface ChatScreenProps { readonly chatUri: ChatUri }

export default function ChatScreen(props: ChatScreenProps): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme<MD3Theme>();
  const actions = useCloudActions();
  const view = useCloudSelector((state) => selectChatViewModel({
    chatUri: props.chatUri,
    chatState: selectChatState(state, props.chatUri),
    catalog: selectRootCatalog(state),
  }));
  const syncStatus = useCloudSelector((state) => state.sync.status);
  const chatOperationError = useCloudSelector((state) => state.chatOperationError);
  const subscribeError = useCloudSelector((state) => (
    state.operationError?.operation === 'subscribe' && state.operationError.chatUri === props.chatUri
      ? state.operationError
      : undefined
  ));
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [commands, setCommands] = useState<readonly HostSlashCommand[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState<Readonly<Record<string, boolean>>>({});
  const [toolOpen, setToolOpen] = useState<Readonly<Record<string, boolean>>>({});
  const [approvalId, setApprovalId] = useState<string | undefined>();
  const [inputId, setInputId] = useState<string | undefined>();
  const [dismissedApprovalId, setDismissedApprovalId] = useState<string | undefined>();
  const [dismissedInputId, setDismissedInputId] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), 2400);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  const activeApproval = view.pendingApprovals.find((candidate) => candidate.id === approvalId)
    ?? (approvalId === undefined ? view.pendingApprovals.find((candidate) => candidate.id !== dismissedApprovalId) : undefined);
  const activeInput = view.pendingInputs.find((candidate) => candidate.id === inputId)
    ?? (inputId === undefined ? view.pendingInputs.find((candidate) => candidate.id !== dismissedInputId) : undefined);

  useEffect(() => {
    if (view.pendingApprovals.length === 0) {
      setApprovalId(undefined);
      setDismissedApprovalId(undefined);
    } else if (approvalId !== undefined && !view.pendingApprovals.some((candidate) => candidate.id === approvalId)) {
      setApprovalId(undefined);
      if (dismissedApprovalId !== undefined && !view.pendingApprovals.some((candidate) => candidate.id === dismissedApprovalId)) setDismissedApprovalId(undefined);
    } else if (approvalId === undefined) {
      setApprovalId(view.pendingApprovals.find((candidate) => candidate.id !== dismissedApprovalId)?.id);
    }
  }, [approvalId, dismissedApprovalId, view.pendingApprovals]);
  useEffect(() => {
    if (view.pendingInputs.length === 0) {
      setInputId(undefined);
      setDismissedInputId(undefined);
    } else if (inputId !== undefined && !view.pendingInputs.some((candidate) => candidate.id === inputId)) {
      setInputId(undefined);
      if (dismissedInputId !== undefined && !view.pendingInputs.some((candidate) => candidate.id === dismissedInputId)) setDismissedInputId(undefined);
    } else if (inputId === undefined) {
      setInputId(view.pendingInputs.find((candidate) => candidate.id !== dismissedInputId)?.id);
    }
  }, [dismissedInputId, inputId, view.pendingInputs]);

  const send = useCallback(async (): Promise<void> => {
    const prompt = draft.trim();
    if (prompt.length === 0 || sending || syncStatus !== 'connected') return;
    setSending(true);
    try {
      const result = await actions.sendChat({ chatUri: props.chatUri, prompt });
      if (result.status === 'accepted') setDraft('');
    } finally { setSending(false); }
  }, [actions, draft, props.chatUri, sending, syncStatus]);

  const stop = useCallback(async (): Promise<void> => {
    const turnId = view.activeTurn?.id;
    if (turnId === undefined || stopping) return;
    setStopping(true);
    try { await actions.interruptChat({ chatUri: props.chatUri, turnId }); } finally { setStopping(false); }
  }, [actions, props.chatUri, stopping, view.activeTurn?.id]);

  const toggleReasoning = useCallback((partId: string): void => {
    setReasoningOpen((current) => ({ ...current, [partId]: current[partId] !== true }));
  }, []);
  const toggleTool = useCallback((partId: string): void => {
    setToolOpen((current) => ({ ...current, [partId]: current[partId] !== true }));
  }, []);
  const openCommands = useCallback(async (): Promise<void> => {
    setAttachmentMenuOpen(true);
    if (commands.length > 0 || commandsLoading) return;
    setCommandsLoading(true);
    try {
      setCommands(await actions.supportedCommands(props.chatUri));
    } finally {
      setCommandsLoading(false);
    }
  }, [actions, commands.length, commandsLoading, props.chatUri]);
  const showNotice = useCallback((message: string): void => setNotice(message), []);
  const renderItem = useCallback(({ item }: ListRenderItemInfo<ChatTranscriptItem>) => (
    <TranscriptItem
      item={item}
      openReasoning={item.kind === 'part' && item.part.kind === 'reasoning' && reasoningOpen[item.part.id] === true}
      openTool={item.kind === 'part' && item.part.kind === 'tool' && toolOpen[item.part.id] === true}
      reasoningSummary={item.kind === 'part' && item.part.kind === 'reasoning' ? reasoningSummaryForItem(item, view) : undefined}
      reduceMotion={reduceMotion}
      streaming={item.kind === 'part' && item.part.kind === 'reasoning' && view.activeTurn?.id === item.turnId && view.status === 'in_progress'}
      onToggleReasoning={toggleReasoning}
      onToggleTool={toggleTool}
    />
  ), [reasoningOpen, reduceMotion, toggleReasoning, toggleTool, toolOpen, view]);
  const active = view.activeTurn !== undefined && view.status === 'in_progress';
  const canChangeComposer = !sending && !stopping && !active;
  const composerDisabled = sending || stopping;

  const closeComposerMenus = useCallback((): void => {
    setAttachmentMenuOpen(false);
  }, []);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={8} style={styles.flex}>
        <View style={styles.flex}>
          <View style={styles.headerChrome}>
            <View style={styles.headerRow}>
              <IconButton
                accessibilityLabel="返回首页"
                icon={({ color, size }) => <MaterialCommunityIcons color={color} name="chevron-left" size={size + 4} />}
                onPress={() => router.back()}
                size={44}
              />
              <View style={styles.headerIdentity}>
                <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.chatTitle, { color: theme.colors.onSurface }]}>{view.title}</Text>
                <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.chatSubtitle, { color: theme.colors.onSurfaceVariant }]}>
                  {view.workspaceName} · {view.hostName} · {view.hostStatusLabel}
                </Text>
              </View>
              <IconButton
                accessibilityLabel="会话更多选项"
                icon={({ color, size }) => <MaterialCommunityIcons color={color} name="dots-horizontal" size={size} />}
                onPress={() => showNotice('会话操作：重命名、归档（规划中）')}
                size={44}
              />
            </View>
          </View>
          {syncStatus !== 'connected' ? <View style={[styles.statusBanner, { backgroundColor: theme.colors.surfaceVariant }]}><MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="cloud-off-outline" size={18} /><Text style={[styles.statusBannerText, { color: theme.colors.onSurfaceVariant }]}>{syncStatus === 'reconnecting' ? '连接已断开，正在重新连接；当前内容保留在本机' : '当前未连接 Host，消息不会显示为已发送'}</Text><Button compact onPress={actions.retryConnection}>重试</Button></View> : null}
          {subscribeError !== undefined ? <View style={[styles.errorBanner, { backgroundColor: theme.colors.errorContainer }]}><MaterialCommunityIcons color={theme.colors.onErrorContainer} name="alert-circle-outline" size={18} /><Text style={[styles.errorText, { color: theme.colors.onErrorContainer }]}>无法载入这个会话（{subscribeError.code}）</Text><Button compact onPress={() => void actions.subscribeChat(props.chatUri)}>重试</Button><IconButton accessibilityLabel="关闭错误" icon="close" onPress={actions.clearOperationError} size={22} /></View> : null}
          {chatOperationError !== undefined ? <View style={[styles.errorBanner, { backgroundColor: theme.colors.errorContainer }]}><MaterialCommunityIcons color={theme.colors.onErrorContainer} name="alert-circle-outline" size={18} /><Text style={[styles.errorText, { color: theme.colors.onErrorContainer }]}>操作未完成，请重试（{chatOperationError.code}）</Text><IconButton accessibilityLabel="关闭错误" icon="close" onPress={actions.clearChatOperationError} size={22} /></View> : null}
          <FlatList contentContainerStyle={[styles.transcript, { paddingBottom: 178 + insets.bottom }]} data={view.transcript} keyExtractor={(item) => item.key} ListEmptyComponent={<EmptyTranscript failed={subscribeError !== undefined} status={view.status} />} renderItem={renderItem} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" />
          <View style={[styles.composerDock, { bottom: Math.max(insets.bottom, 10) }]}>
            <GlassPanel blurIntensity={72} glassEffectStyle="regular" materialElevation={3} materialShape="extraLarge" style={styles.composerShell}>
              <NativeTextInput accessibilityLabel="消息输入框" editable={!composerDisabled} multiline maxLength={10000} onChangeText={setDraft} onSubmitEditing={() => void send()} placeholder="给 Cloud 发送消息" placeholderTextColor={theme.colors.onSurfaceVariant} style={[styles.composerInput, { color: theme.colors.onSurface }]} value={draft} />
              <View style={styles.composerToolbar}>
                <Menu
                  visible={attachmentMenuOpen}
                  onDismiss={() => setAttachmentMenuOpen(false)}
                  anchor={(
                    <Pressable
                      accessibilityLabel="添加内容"
                      accessibilityRole="button"
                      accessibilityState={{ expanded: attachmentMenuOpen, disabled: !canChangeComposer }}
                      disabled={!canChangeComposer}
                      onPress={() => { closeComposerMenus(); void openCommands(); }}
                      style={({ pressed }) => [styles.composerToolButton, pressed && !reduceMotion ? styles.pressed : null]}
                    >
                      <MaterialCommunityIcons color={canChangeComposer ? theme.colors.onSurfaceVariant : theme.colors.outline} name="plus" size={21} />
                    </Pressable>
                  )}
                  anchorPosition="top"
                  contentStyle={styles.menuContent}
                >
                  {commandsLoading ? <Menu.Item disabled leadingIcon="loading" onPress={() => undefined} title="正在从 Host 获取命令" /> : null}
                  {!commandsLoading && commands.length === 0 ? <Menu.Item disabled leadingIcon="slash-forward" onPress={() => undefined} title="当前会话没有可用命令" /> : null}
                  {commands.map((command) => (
                    <Menu.Item
                      key={command.name}
                      leadingIcon="slash-forward"
                      onPress={() => {
                        setAttachmentMenuOpen(false);
                        setDraft(`/${command.name}${command.argumentHint.length > 0 ? ` ${command.argumentHint}` : ' '}`);
                      }}
                      title={`/${command.name}${command.argumentHint.length > 0 ? `  ${command.argumentHint}` : ''}`}
                    />
                  ))}
                </Menu>
                <View style={styles.toolbarSpacer} />
                <View accessibilityLabel="当前会话模型由 Host 决定" style={styles.modelChip}>
                  <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.modelText, { color: theme.colors.onSurfaceVariant }]}>Host 模型</Text>
                </View>
                <View accessibilityLabel="当前会话思考策略由 Host 决定" style={styles.strengthChip}>
                  <Text style={[styles.strengthText, { color: theme.colors.onSurfaceVariant }]}>Host</Text>
                </View>
                {active ? (
                  <Pressable accessibilityLabel="停止运行" accessibilityRole="button" disabled={stopping} onPress={() => void stop()} style={({ pressed }) => [styles.sendButton, { backgroundColor: theme.colors.error }, pressed ? styles.sendPressed : null]}>
                    {stopping && !reduceMotion ? <ActivityIndicator color={theme.colors.onError} size="small" /> : <MaterialCommunityIcons color={theme.colors.onError} name="stop" size={20} />}
                  </Pressable>
                ) : (
                  <Pressable accessibilityLabel="发送消息" accessibilityRole="button" accessibilityState={{ disabled: draft.trim().length === 0 || sending || syncStatus !== 'connected' }} disabled={draft.trim().length === 0 || sending || syncStatus !== 'connected'} onPress={() => void send()} style={({ pressed }) => [styles.sendButton, { backgroundColor: draft.trim().length === 0 || sending || syncStatus !== 'connected' ? theme.colors.outlineVariant : theme.colors.primary }, pressed && !reduceMotion ? styles.sendPressed : null]}>
                    {sending && !reduceMotion ? <ActivityIndicator color={theme.colors.onPrimary} size="small" /> : <MaterialCommunityIcons color={draft.trim().length === 0 || sending || syncStatus !== 'connected' ? theme.colors.onSurfaceVariant : theme.colors.onPrimary} name={sending ? 'clock-outline' : 'arrow-up'} size={21} />}
                  </Pressable>
                )}
              </View>
            </GlassPanel>
          </View>
        </View>
      </KeyboardAvoidingView>
      <ApprovalSheet approval={activeApproval} reduceMotion={reduceMotion} onClose={() => { if (activeApproval !== undefined) setDismissedApprovalId(activeApproval.id); setApprovalId(undefined); }} onResolve={async (decision) => {
        if (activeApproval === undefined) return;
        const result = decision === 'allow'
          ? await actions.allowApproval({ channel: props.chatUri, approvalId: activeApproval.id, decision: 'allow', decisionClassification: 'user_temporary' })
          : await actions.denyApproval({ channel: props.chatUri, approvalId: activeApproval.id, decision: 'deny', decisionClassification: 'user_reject', message: '用户拒绝执行此操作', interrupt: true });
        if (result.status === 'accepted' || result.status === 'already_resolved') { setDismissedApprovalId(activeApproval.id); setApprovalId(undefined); setNotice(result.status === 'already_resolved' ? '该权限请求已由其他客户端处理' : '权限决定已提交，等待 Host 确认'); }
      }} />
      <InputSheet input={activeApproval === undefined ? activeInput : undefined} reduceMotion={reduceMotion} onClose={() => { if (activeInput !== undefined) setDismissedInputId(activeInput.id); setInputId(undefined); }} onResolve={async (answers) => {
        if (activeInput === undefined) return;
        const result = await actions.resolveInput({ channel: props.chatUri, inputId: activeInput.id, ...(answers === undefined ? {} : { answers }) });
        if (result.status === 'accepted' || result.status === 'already_resolved') { setDismissedInputId(activeInput.id); setInputId(undefined); setNotice(result.status === 'already_resolved' ? '该问题已由其他客户端处理' : '回答已提交，等待 Host 继续'); }
      }} />
      {notice !== undefined ? (
        <Pressable accessibilityRole="button" accessibilityLabel="关闭提示" onPress={() => setNotice(undefined)} style={[styles.noticeToast, { top: insets.top + 54, backgroundColor: theme.colors.onSurface }]}>
          <MaterialCommunityIcons color={theme.colors.surface} name="information-outline" size={17} />
          <Text style={[styles.noticeText, { color: theme.colors.surface }]}>{notice}</Text>
          <MaterialCommunityIcons color={theme.colors.surface} name="close" size={17} />
        </Pressable>
      ) : null}
    </SafeAreaView>
  );
}

function selectChatState(state: CloudRuntimeState, chatUri: ChatUri) {
  const entry = state.sync.resources.find((candidate) => candidate.resource === chatUri);
  return entry?.resource === chatUri && 'turns' in entry.state ? entry.state : undefined;
}

function reasoningSummaryForItem(
  item: Extract<ChatTranscriptItem, { kind: 'part' }>,
  view: ChatViewModel,
): string | undefined {
  if (item.part.kind !== 'reasoning') return undefined;
  const turn = view.activeTurn?.id === item.turnId
    ? view.activeTurn
    : view.history.find((candidate) => candidate.id === item.turnId);
  if (turn?.completedAt === undefined) return '思考过程';
  const elapsedMs = Date.parse(turn.completedAt) - Date.parse(turn.startedAt);
  // Imported Claude history can contain sparse timestamps around resumed or
  // interrupted turns. Avoid presenting that wall-clock gap as thinking time.
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 60 * 60 * 1000) return '思考过程';
  const elapsedSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  return `用时${Math.floor(elapsedSeconds / 60)}分${String(elapsedSeconds % 60).padStart(2, '0')}秒`;
}

interface TranscriptItemProps {
  readonly item: ChatTranscriptItem;
  readonly openReasoning: boolean;
  readonly openTool: boolean;
  readonly reduceMotion: boolean;
  readonly streaming: boolean;
  readonly reasoningSummary?: string;
  readonly onToggleReasoning: (partId: string) => void;
  readonly onToggleTool: (partId: string) => void;
}
function TranscriptItem(props: TranscriptItemProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  if (props.item.kind === 'prompt') {
    return <View style={styles.promptRow}><View style={[styles.promptBubble, { backgroundColor: theme.colors.onSurface }]}><Text style={[styles.promptText, { color: theme.colors.surface }]}>{props.item.text}</Text></View></View>;
  }
  if (props.item.kind === 'failure') return <FailureView failure={props.item} />;
  return <PartView part={props.item.part} openReasoning={props.openReasoning} openTool={props.openTool} reasoningSummary={props.reasoningSummary} reduceMotion={props.reduceMotion} streaming={props.streaming} onToggleReasoning={props.onToggleReasoning} onToggleTool={props.onToggleTool} />;
}

function FailureView({ failure }: { readonly failure: Extract<ChatTranscriptItem, { kind: 'failure' }> }): JSX.Element {
  const theme = useTheme<MD3Theme>();
  return (
    <GlassPanel materialElevation={1} materialShape="medium" materialTone="surfaceContainerLow" style={[styles.failureCard, { borderColor: theme.colors.error }]}>
      <View accessible accessibilityRole="alert" accessibilityLabel={`执行失败。${failure.message}`} style={styles.failureContent}>
        <View style={styles.failureHeader}>
          <MaterialCommunityIcons color={theme.colors.error} name="alert-circle-outline" size={21} />
          <Text style={[styles.failureLabel, { color: theme.colors.error }]}>执行失败</Text>
        </View>
        <Text style={[styles.failureMessage, { color: theme.colors.onSurface }]}>{failure.message}</Text>
      </View>
    </GlassPanel>
  );
}

interface PartViewProps { readonly part: ChatPartViewModel; readonly openReasoning: boolean; readonly openTool: boolean; readonly reduceMotion: boolean; readonly streaming: boolean; readonly reasoningSummary?: string; readonly onToggleReasoning: (partId: string) => void; readonly onToggleTool: (partId: string) => void }
function PartView(props: PartViewProps): JSX.Element { const theme = useTheme<MD3Theme>(); switch (props.part.kind) {
  case 'markdown': return <View style={styles.assistantBlock}>{props.part.blocks.map((block, index) => block.kind === 'heading' ? <Text key={`${props.part.id}:h:${index}`} variant="titleLarge" style={[styles.markdownHeading, { color: theme.colors.onSurface }]}>{block.text}</Text> : block.kind === 'bullet' ? <View key={`${props.part.id}:b:${index}`} style={styles.bulletRow}><Text style={[styles.bullet, { color: theme.colors.primary }]}>•</Text><Text style={[styles.markdownText, { color: theme.colors.onSurface }]}>{block.text}</Text></View> : block.kind === 'code' ? <View key={`${props.part.id}:c:${index}`} style={[styles.codeBlock, { backgroundColor: theme.colors.surfaceVariant }]}><Text style={[styles.codeLanguage, { color: theme.colors.primary }]}>{block.language || '代码'}</Text><Text selectable style={[styles.codeText, { color: theme.colors.onSurfaceVariant }]}>{block.text}</Text></View> : <Text key={`${props.part.id}:p:${index}`} style={[styles.markdownText, { color: theme.colors.onSurface }]}>{block.text}</Text>)}</View>;
  case 'reasoning': {
    if (props.streaming) {
      return <View accessibilityLabel="正在生成思考" style={styles.thinking}><View style={styles.thinkingHeader}>{props.reduceMotion ? <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="circle-outline" size={14} /> : <ActivityIndicator color={theme.colors.onSurfaceVariant} size="small" />}<Text style={[styles.thinkingLabel, { color: theme.colors.onSurfaceVariant }]}>正在思考</Text></View><Text style={[styles.reasoningText, { color: theme.colors.onSurfaceVariant }]}>{props.part.content}</Text></View>;
    }
    return <Pressable accessibilityRole="button" accessibilityState={{ expanded: props.openReasoning }} onPress={() => props.onToggleReasoning(props.part.id)} style={({ pressed }) => [styles.reasoningRow, { borderBottomColor: theme.colors.outlineVariant }, pressed && !props.reduceMotion ? styles.pressed : null]}><MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="head-lightbulb-outline" size={19} /><Text style={[styles.reasoningTitle, { color: theme.colors.onSurfaceVariant }]}>{props.reasoningSummary ?? '思考过程'}</Text><View style={styles.toolbarSpacer} /><MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name={props.openReasoning ? 'chevron-up' : 'chevron-down'} size={20} />{props.openReasoning ? <Text style={[styles.reasoningText, { color: theme.colors.onSurfaceVariant }]}>{props.part.content}</Text> : null}</Pressable>;
  }
  case 'tool': return <ToolCard open={props.part.status === 'running' || props.part.status === 'ready' || props.openTool} part={props.part} onToggle={() => props.onToggleTool(props.part.id)} />;
} }

function ToolCard({ part, open, onToggle }: { readonly part: Extract<ChatPartViewModel, { kind: 'tool' }>; readonly open: boolean; readonly onToggle: () => void }): JSX.Element { const theme = useTheme<MD3Theme>(); const icon = part.status === 'error' ? 'alert-circle-outline' : part.status === 'success' ? 'check-circle-outline' : 'progress-clock'; const color = part.status === 'error' ? theme.colors.error : theme.colors.primary; const terminal = part.status === 'success' || part.status === 'error'; return <MaterialSurface elevation={1} shape="medium" tone="surfaceContainerLow" style={styles.toolCard}><Pressable accessibilityRole={terminal ? 'button' : undefined} accessibilityState={terminal ? { expanded: open } : undefined} disabled={!terminal} onPress={onToggle} style={styles.toolHeader}><MaterialCommunityIcons color={color} name={icon} size={22} /><Text style={[styles.toolName, { color: theme.colors.onSurface }]}>{part.name}</Text><View style={styles.toolbarSpacer} /><Text variant="labelMedium" style={{ color }}>{toolStatusLabel(part.status)}</Text>{terminal ? <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name={open ? 'chevron-up' : 'chevron-down'} size={19} /> : null}</Pressable>{open && part.formattedInput.length > 0 ? <Text selectable style={[styles.toolInput, { color: theme.colors.onSurfaceVariant }]}>{part.formattedInput}</Text> : null}{open && part.output !== undefined ? <Text selectable style={[styles.toolOutput, { color: theme.colors.onSurface }]}>{part.output}</Text> : null}{open && part.error !== undefined ? <Text selectable style={[styles.toolError, { color: theme.colors.error }]}>{part.error}</Text> : null}</MaterialSurface>; }

function EmptyTranscript(props: { readonly failed: boolean; readonly status: string }): JSX.Element { const theme = useTheme<MD3Theme>(); const loading = props.status === 'loading' && !props.failed; return <View style={styles.emptyTranscript}><MaterialCommunityIcons color={theme.colors.outline} name={props.failed ? 'message-alert-outline' : loading ? 'cloud-sync-outline' : 'message-text-outline'} size={34} /><Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>{props.failed ? '这个历史会话暂时无法从 Host 载入' : loading ? '正在同步会话' : '等待你的第一条消息'}</Text></View>; }

interface ApprovalSheetProps { readonly approval: PendingApprovalViewModel | undefined; readonly reduceMotion: boolean; readonly onClose: () => void; readonly onResolve: (decision: 'allow' | 'deny') => Promise<void> }
function ApprovalSheet(props: ApprovalSheetProps): JSX.Element { const theme = useTheme<MD3Theme>(); const [resolving, setResolving] = useState(false); if (props.approval === undefined) return <></>; const resolve = async (decision: 'allow' | 'deny'): Promise<void> => { setResolving(true); try { await props.onResolve(decision); } finally { setResolving(false); } }; return <Modal animationType={props.reduceMotion ? 'fade' : 'slide'} onRequestClose={props.onClose} transparent visible><View style={styles.sheetBackdrop}><Pressable accessibilityLabel="关闭权限请求" onPress={props.onClose} style={StyleSheet.absoluteFill} /><GlassPanel blurIntensity={82} glassEffectStyle="regular" materialElevation={5} materialShape="extraLarge" style={styles.sheet}><View style={[styles.sheetHandle, { backgroundColor: theme.colors.outline }]} /><Text variant="headlineSmall" style={styles.sheetTitle}>权限请求</Text><Text style={[styles.sheetDescription, { color: theme.colors.onSurfaceVariant }]}>允许在 {props.approval.hostName} 上执行此工具？</Text><View style={[styles.requestIdentity, { backgroundColor: theme.colors.surfaceVariant }]}><MaterialCommunityIcons color={theme.colors.primary} name="wrench-outline" size={22} /><View style={styles.requestCopy}><Text style={styles.requestTool}>{props.approval.displayName}</Text><Text style={[styles.requestWorkspace, { color: theme.colors.onSurfaceVariant }]}>{props.approval.workspaceName}</Text></View></View><Text selectable style={[styles.requestInput, { backgroundColor: theme.colors.surfaceVariant, color: theme.colors.onSurfaceVariant }]}>{props.approval.normalizedInput}</Text><View style={styles.sheetActions}><Button disabled={resolving} mode="outlined" onPress={() => void resolve('deny')} style={styles.sheetButton}>拒绝</Button><Button disabled={resolving} icon="check" mode="contained" onPress={() => void resolve('allow')} style={styles.sheetButton}>允许</Button></View></GlassPanel></View></Modal>; }

interface InputSheetProps { readonly input: PendingInputViewModel | undefined; readonly reduceMotion: boolean; readonly onClose: () => void; readonly onResolve: (answers: Readonly<Record<string, string>> | undefined) => Promise<void> }
function InputSheet(props: InputSheetProps): JSX.Element { const theme = useTheme<MD3Theme>(); const [answers, setAnswers] = useState<Readonly<Record<string, readonly string[]>>>({}); const [custom, setCustom] = useState<Readonly<Record<string, string>>>({}); const [resolving, setResolving] = useState(false); useEffect(() => { setAnswers({}); setCustom({}); }, [props.input?.id]); if (props.input === undefined) return <></>; const toggleOption = (questionKey: string, label: string, multiSelect: boolean): void => { setAnswers((current) => { const previous = current[questionKey] ?? []; if (!multiSelect) return { ...current, [questionKey]: [label] }; return { ...current, [questionKey]: previous.includes(label) ? previous.filter((value) => value !== label) : [...previous, label] }; }); }; const submit = async (): Promise<void> => { if (props.input === undefined) return; const output = buildStructuredInputAnswers(props.input, answers, custom); setResolving(true); try { await props.onResolve(output); } finally { setResolving(false); } }; return <Modal animationType={props.reduceMotion ? 'fade' : 'slide'} onRequestClose={props.onClose} transparent visible><View style={styles.sheetBackdrop}><Pressable accessibilityLabel="关闭问题" onPress={props.onClose} style={StyleSheet.absoluteFill} /><GlassPanel blurIntensity={82} glassEffectStyle="regular" materialElevation={5} materialShape="extraLarge" style={styles.sheet}><View style={[styles.sheetHandle, { backgroundColor: theme.colors.outline }]} /><Text variant="headlineSmall" style={styles.sheetTitle}>需要你的输入</Text><Text style={[styles.sheetDescription, { color: theme.colors.onSurfaceVariant }]}>Cloud 正在等待你回答以下问题</Text>{props.input.questions.map((question, index) => <View key={`${props.input?.id}:question:${index}`} style={styles.questionBlock}><Text variant="labelLarge" style={{ color: theme.colors.primary }}>{question.header}</Text><Text style={styles.questionText}>{question.question}</Text>{question.options.map((option) => { const selected = answers[question.question]?.includes(option.label) === true; return <Pressable key={option.label} accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'} accessibilityState={{ checked: selected }} onPress={() => toggleOption(question.question, option.label, question.multiSelect)} style={[styles.optionRow, selected ? { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryContainer } : { borderColor: theme.colors.outlineVariant }]}><MaterialCommunityIcons color={selected ? theme.colors.primary : theme.colors.outline} name={selected ? (question.multiSelect ? 'checkbox-marked' : 'radiobox-marked') : (question.multiSelect ? 'checkbox-blank-outline' : 'radiobox-blank')} size={22} /><View style={styles.optionCopy}><Text style={styles.optionLabel}>{option.label}</Text><Text style={[styles.optionDescription, { color: theme.colors.onSurfaceVariant }]}>{option.description}</Text></View></Pressable>; })}<NativeTextInput accessibilityLabel={`${question.header} 自由输入`} onChangeText={(value) => setCustom((current) => ({ ...current, [question.question]: value }))} placeholder="或输入自定义回答" placeholderTextColor={theme.colors.onSurfaceVariant} style={[styles.customInput, { borderColor: theme.colors.outlineVariant, color: theme.colors.onSurface }]} value={custom[question.question] ?? ''} /></View>)}<View style={styles.sheetActions}><Button disabled={resolving} mode="outlined" onPress={() => void props.onResolve(undefined)} style={styles.sheetButton}>取消</Button><Button disabled={resolving} icon="send" mode="contained" onPress={() => void submit()} style={styles.sheetButton}>提交回答</Button></View></GlassPanel></View></Modal>; }

function toolStatusLabel(status: Extract<ChatPartViewModel, { kind: 'tool' }>['status']): string { switch (status) { case 'running': return '运行中'; case 'ready': return '等待执行'; case 'success': return '已完成'; case 'error': return '失败'; } }
const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  headerChrome: { paddingHorizontal: 8, paddingTop: 2, paddingBottom: 8 },
  headerRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center' },
  headerIdentity: { flex: 1, minWidth: 0, alignItems: 'center', paddingHorizontal: 4, gap: 2 },
  chatTitle: { maxWidth: '82%', fontSize: 16, lineHeight: 21, fontWeight: '700' },
  chatSubtitle: { maxWidth: '90%', fontSize: 11, lineHeight: 15 },
  statusBanner: { marginHorizontal: 18, marginTop: 2, minHeight: 46, paddingLeft: 12, paddingRight: 6, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 7 },
  statusBannerText: { flex: 1, fontSize: 12, lineHeight: 17 },
  errorBanner: { marginHorizontal: 18, marginTop: 8, minHeight: 42, paddingLeft: 11, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 7 },
  errorText: { flex: 1, fontSize: 12, lineHeight: 17 },
  noticeToast: { position: 'absolute', zIndex: 20, alignSelf: 'center', minHeight: 42, maxWidth: '90%', paddingHorizontal: 15, borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 8, shadowColor: '#000000', shadowOpacity: 0.20, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 5 },
  noticeText: { flexShrink: 1, fontSize: 12, lineHeight: 17 },
  transcript: { flexGrow: 1, paddingHorizontal: 18, paddingTop: 10, gap: 18 },
  promptRow: { alignItems: 'flex-end' },
  promptBubble: { maxWidth: '88%', paddingHorizontal: 14, paddingVertical: 11, borderRadius: 20, borderBottomRightRadius: 6 },
  promptText: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  failureCard: { marginHorizontal: 8, padding: 13, borderWidth: StyleSheet.hairlineWidth },
  failureContent: { gap: 8 },
  failureHeader: { minHeight: 24, flexDirection: 'row', alignItems: 'center', gap: 8 },
  failureLabel: { fontSize: 15, fontWeight: '700' },
  failureMessage: { fontSize: 14, lineHeight: 21 },
  assistantBlock: { maxWidth: '88%', paddingHorizontal: 8, gap: 9 },
  markdownText: { fontSize: 16, lineHeight: 25 },
  markdownHeading: { marginTop: 4, fontWeight: '700' },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  bullet: { fontSize: 21, lineHeight: 25 },
  codeBlock: { padding: 12, borderRadius: 12, gap: 6 },
  codeLanguage: { fontSize: 11, fontWeight: '700' },
  codeText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 20 },
  thinking: { maxWidth: '88%', marginHorizontal: 8, marginVertical: 3, paddingVertical: 9, paddingLeft: 12, borderLeftWidth: 2, gap: 6 },
  thinkingHeader: { minHeight: 22, flexDirection: 'row', alignItems: 'center', gap: 7 },
  thinkingLabel: { fontSize: 13, fontWeight: '600' },
  reasoningRow: { maxWidth: '88%', minHeight: 44, marginHorizontal: 8, paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  reasoningTitle: { fontSize: 13, fontWeight: '500' },
  reasoningText: { width: '100%', paddingTop: 3, paddingLeft: 27, fontSize: 13, lineHeight: 21 },
  toolCard: { maxWidth: '88%', marginHorizontal: 8, marginTop: 2, padding: 12, gap: 8, borderWidth: StyleSheet.hairlineWidth },
  toolHeader: { minHeight: 25, flexDirection: 'row', alignItems: 'center', gap: 8 },
  toolName: { flexShrink: 1, fontSize: 14, fontWeight: '700' },
  toolInput: { padding: 9, borderRadius: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, lineHeight: 17 },
  toolOutput: { paddingTop: 3, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, lineHeight: 17 },
  toolError: { fontSize: 13, lineHeight: 19 },
  emptyTranscript: { flex: 1, minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyText: { fontSize: 15 },
  composerDock: { position: 'absolute', zIndex: 10, left: 12, right: 12 },
  composerShell: { padding: 8, paddingBottom: 7, borderRadius: 28 },
  composerInput: { minHeight: 56, maxHeight: 112, paddingHorizontal: 10, paddingTop: 10, paddingBottom: 8, fontSize: 16, lineHeight: 22, textAlignVertical: 'top' },
  composerToolbar: { minHeight: 52, paddingHorizontal: 2, paddingTop: 7, paddingBottom: 1, flexDirection: 'row', alignItems: 'center', gap: 4 },
  toolbarSpacer: { flex: 1 },
  composerToolButton: { minWidth: 44, height: 44, paddingHorizontal: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  pressed: { backgroundColor: 'rgba(127,127,127,0.12)' },
  modelChip: { minWidth: 44, maxWidth: 102, minHeight: 44, flexShrink: 1, paddingHorizontal: 8, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 },
  modelText: { minWidth: 0, flexShrink: 1, fontSize: 11, fontWeight: '600' },
  strengthChip: { minWidth: 44, minHeight: 44, paddingHorizontal: 7, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  strengthText: { fontSize: 11, fontWeight: '600' },
  sendButton: { width: 44, height: 44, flexShrink: 0, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendPressed: { transform: [{ scale: 0.93 }] },
  menuContent: { maxHeight: 280 },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(20,26,38,0.22)' },
  sheet: { maxHeight: '88%', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, borderTopLeftRadius: 28, borderTopRightRadius: 28, gap: 11 },
  sheetHandle: { alignSelf: 'center', width: 42, height: 5, borderRadius: 3, marginBottom: 4 },
  sheetTitle: { fontWeight: '800' },
  sheetDescription: { fontSize: 15, lineHeight: 22 },
  requestIdentity: { minHeight: 58, padding: 11, borderRadius: 11, flexDirection: 'row', alignItems: 'center', gap: 10 },
  requestCopy: { flex: 1, gap: 3 },
  requestTool: { fontSize: 16, fontWeight: '700' },
  requestWorkspace: { fontSize: 13 },
  requestInput: { maxHeight: 160, padding: 12, borderRadius: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 20 },
  sheetActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  sheetButton: { flex: 1 },
  questionBlock: { gap: 7 },
  questionText: { fontSize: 16, lineHeight: 23, fontWeight: '600' },
  optionRow: { minHeight: 54, paddingHorizontal: 11, paddingVertical: 8, borderWidth: 1, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 9 },
  optionCopy: { flex: 1, gap: 2 },
  optionLabel: { fontSize: 15, fontWeight: '600' },
  optionDescription: { fontSize: 12, lineHeight: 17 },
  customInput: { minHeight: 44, paddingHorizontal: 11, borderWidth: 1, borderRadius: 10, fontSize: 15 },
});

export function parseChatRouteParam(value: string | string[] | undefined): ChatUri | undefined { const candidate = Array.isArray(value) ? value[0] : value; if (candidate === undefined) return undefined; try { return parseChatUri(candidate); } catch { return undefined; } }
