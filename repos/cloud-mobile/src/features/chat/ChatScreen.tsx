import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useCallback, useEffect, useState, type ComponentProps, type JSX } from 'react';
import {
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
  type ChatTranscriptItem,
  type PendingApprovalViewModel,
  type PendingInputViewModel,
} from './chatSelectors';
import { parseChatUri, type ChatUri } from '../../protocol/resourceUri';

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
  const catalog = useCloudSelector(selectRootCatalog);
  const selectedModelId = useCloudSelector((state) => state.selection.modelId);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState<Readonly<Record<string, boolean>>>({});
  const [approvalId, setApprovalId] = useState<string | undefined>();
  const [inputId, setInputId] = useState<string | undefined>();
  const [dismissedApprovalId, setDismissedApprovalId] = useState<string | undefined>();
  const [dismissedInputId, setDismissedInputId] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

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
  const renderItem = useCallback(({ item }: ListRenderItemInfo<ChatTranscriptItem>) => (
    <TranscriptItem
      item={item}
      openReasoning={item.kind === 'part' && item.part.kind === 'reasoning' && reasoningOpen[item.part.id] === true}
      onToggleReasoning={toggleReasoning}
    />
  ), [reasoningOpen, toggleReasoning]);
  const model = catalog?.models.find((candidate) => candidate.id === selectedModelId)
    ?? catalog?.models.find((candidate) => candidate.id === catalog.defaultModelId)
    ?? catalog?.models[0];
  const active = view.activeTurn !== undefined && view.status === 'in_progress';

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={8} style={styles.flex}>
        <View style={styles.flex}>
          <GlassPanel blurIntensity={62} glassEffectStyle="regular" materialElevation={2} materialShape="large" style={styles.headerChrome}>
            <View style={styles.headerRow}>
              <IconButton accessibilityLabel="返回首页" icon={({ color, size }) => <MaterialCommunityIcons color={color} name="chevron-left" size={size + 4} />} onPress={() => router.back()} size={44} />
              <View style={styles.headerIdentity}>
                <Text variant="titleLarge" style={[styles.brand, { color: theme.colors.onSurface }]}>Cloud</Text>
                <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.chatTitle, { color: theme.colors.onSurfaceVariant }]}>{view.title}</Text>
              </View>
              <IconButton accessibilityLabel="更多操作" icon={({ color, size }) => <MaterialCommunityIcons color={color} name="dots-horizontal" size={size} />} onPress={() => undefined} size={44} />
            </View>
            <View style={styles.contextRow}>
              <ContextChip icon="folder-outline" text={view.workspaceName} />
              <View style={[styles.contextDot, { backgroundColor: theme.colors.outlineVariant }]} />
              <ContextChip icon="server-network-outline" text={view.hostName} />
              <View style={[styles.contextDot, { backgroundColor: theme.colors.outlineVariant }]} />
              <View style={styles.connectionStatus}><View style={[styles.statusDot, { backgroundColor: connectionColor(view.hostStatus, theme) }]} /><Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>{view.hostStatusLabel}</Text></View>
            </View>
          </GlassPanel>
          {syncStatus !== 'connected' ? <View style={[styles.statusBanner, { backgroundColor: theme.colors.surfaceVariant }]}><MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="cloud-off-outline" size={18} /><Text style={[styles.statusBannerText, { color: theme.colors.onSurfaceVariant }]}>{syncStatus === 'reconnecting' ? '连接已断开，正在重新连接；当前内容保留在本机' : '当前未连接 Host，消息不会显示为已发送'}</Text><Button compact onPress={actions.retryConnection}>重试</Button></View> : null}
          {notice !== undefined ? <Pressable accessibilityRole="button" onPress={() => setNotice(undefined)} style={[styles.notice, { backgroundColor: theme.colors.secondaryContainer }]}><MaterialCommunityIcons color={theme.colors.onSecondaryContainer} name="information-outline" size={18} /><Text style={[styles.noticeText, { color: theme.colors.onSecondaryContainer }]}>{notice}</Text><MaterialCommunityIcons color={theme.colors.onSecondaryContainer} name="close" size={18} /></Pressable> : null}
          {chatOperationError !== undefined ? <View style={[styles.errorBanner, { backgroundColor: theme.colors.errorContainer }]}><MaterialCommunityIcons color={theme.colors.onErrorContainer} name="alert-circle-outline" size={18} /><Text style={[styles.errorText, { color: theme.colors.onErrorContainer }]}>操作未完成，请重试（{chatOperationError.code}）</Text><IconButton accessibilityLabel="关闭错误" icon="close" onPress={actions.clearChatOperationError} size={22} /></View> : null}
          <FlatList contentContainerStyle={[styles.transcript, { paddingBottom: Math.max(insets.bottom, 12) }]} data={view.transcript} keyExtractor={(item) => item.key} ListEmptyComponent={<EmptyTranscript status={view.status} />} renderItem={renderItem} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" />
          <GlassPanel blurIntensity={72} glassEffectStyle="regular" materialElevation={3} materialShape="extraLarge" style={[styles.composerShell, { marginBottom: Math.max(insets.bottom, 8) }]}>
            <NativeTextInput accessibilityLabel="消息输入框" editable={!sending && !stopping} multiline onChangeText={setDraft} onSubmitEditing={() => void send()} placeholder="向 Cloud 描述你要完成的任务…" placeholderTextColor={theme.colors.onSurfaceVariant} style={[styles.composerInput, { color: theme.colors.onSurface }]} value={draft} />
            <View style={styles.composerToolbar}>
              <IconButton accessibilityLabel="添加附件" disabled icon={({ color, size }) => <MaterialCommunityIcons color={color} name="plus" size={size} />} size={38} />
              <Menu anchor={<Pressable accessibilityLabel="选择模型" accessibilityRole="button" onPress={() => setModelMenuOpen(true)} style={[styles.modelChip, { backgroundColor: theme.colors.surfaceVariant }]}><MaterialCommunityIcons color={theme.colors.primary} name="cube-outline" size={18} /><Text ellipsizeMode="tail" numberOfLines={1} style={[styles.modelText, { color: theme.colors.onSurface }]}>{model?.displayName ?? '选择模型'}</Text><MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="chevron-down" size={18} /></Pressable>} contentStyle={styles.menuContent} onDismiss={() => setModelMenuOpen(false)} visible={modelMenuOpen}>
                {(catalog?.models ?? []).map((candidate) => <Menu.Item key={candidate.id} leadingIcon="cube-outline" onPress={() => { actions.setModel(candidate.id); setModelMenuOpen(false); }} title={candidate.displayName} />)}
              </Menu>
              <View style={styles.toolbarSpacer} />
              <IconButton accessibilityLabel="语音输入" disabled icon={({ color, size }) => <MaterialCommunityIcons color={color} name="microphone-outline" size={size} />} size={38} />
              {active ? <IconButton accessibilityLabel="停止运行" disabled={stopping} icon={({ color, size }) => <MaterialCommunityIcons color={color} name="stop-circle-outline" size={size} />} iconColor={theme.colors.error} onPress={() => void stop()} size={42} /> : <IconButton accessibilityLabel="发送消息" containerColor={theme.colors.primary} disabled={draft.trim().length === 0 || sending || syncStatus !== 'connected'} icon={({ color, size }) => <MaterialCommunityIcons color={color} name="arrow-up" size={size} />} onPress={() => void send()} size={42} />}
            </View>
            {sending ? <ActivityIndicator accessibilityLabel="正在发送" style={styles.composerActivity} /> : null}
          </GlassPanel>
        </View>
      </KeyboardAvoidingView>
      <ApprovalSheet approval={activeApproval} onClose={() => { if (activeApproval !== undefined) setDismissedApprovalId(activeApproval.id); setApprovalId(undefined); }} onResolve={async (decision) => {
        if (activeApproval === undefined) return;
        const result = decision === 'allow'
          ? await actions.allowApproval({ channel: props.chatUri, approvalId: activeApproval.id, decision: 'allow', decisionClassification: 'user_temporary' })
          : await actions.denyApproval({ channel: props.chatUri, approvalId: activeApproval.id, decision: 'deny', decisionClassification: 'user_reject', message: '用户拒绝执行此操作', interrupt: true });
        if (result.status === 'accepted' || result.status === 'already_resolved') { setDismissedApprovalId(activeApproval.id); setApprovalId(undefined); setNotice(result.status === 'already_resolved' ? '该权限请求已由其他客户端处理' : '权限决定已提交，等待 Host 确认'); }
      }} />
      <InputSheet input={activeApproval === undefined ? activeInput : undefined} onClose={() => { if (activeInput !== undefined) setDismissedInputId(activeInput.id); setInputId(undefined); }} onResolve={async (answers) => {
        if (activeInput === undefined) return;
        const result = await actions.resolveInput({ channel: props.chatUri, inputId: activeInput.id, ...(answers === undefined ? {} : { answers }) });
        if (result.status === 'accepted' || result.status === 'already_resolved') { setDismissedInputId(activeInput.id); setInputId(undefined); setNotice(result.status === 'already_resolved' ? '该问题已由其他客户端处理' : '回答已提交，等待 Host 继续'); }
      }} />
    </SafeAreaView>
  );
}

function selectChatState(state: CloudRuntimeState, chatUri: ChatUri) {
  const entry = state.sync.resources.find((candidate) => candidate.resource === chatUri);
  return entry?.resource === chatUri && 'turns' in entry.state ? entry.state : undefined;
}

interface ContextChipProps { readonly icon: ComponentProps<typeof MaterialCommunityIcons>['name']; readonly text: string }
function ContextChip(props: ContextChipProps): JSX.Element { const theme = useTheme<MD3Theme>(); return <View style={styles.contextChip}><MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name={props.icon} size={15} /><Text ellipsizeMode="tail" numberOfLines={1} style={[styles.contextText, { color: theme.colors.onSurfaceVariant }]}>{props.text}</Text></View>; }

interface TranscriptItemProps { readonly item: ChatTranscriptItem; readonly openReasoning: boolean; readonly onToggleReasoning: (partId: string) => void }
function TranscriptItem(props: TranscriptItemProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  if (props.item.kind === 'prompt') {
    return <View style={styles.promptRow}><View style={[styles.promptBubble, { backgroundColor: theme.colors.primaryContainer }]}><Text style={[styles.promptText, { color: theme.colors.onPrimaryContainer }]}>{props.item.text}</Text></View></View>;
  }
  if (props.item.kind === 'failure') return <FailureView failure={props.item} />;
  return <PartView part={props.item.part} openReasoning={props.openReasoning} onToggleReasoning={props.onToggleReasoning} />;
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

interface PartViewProps { readonly part: ChatPartViewModel; readonly openReasoning: boolean; readonly onToggleReasoning: (partId: string) => void }
function PartView(props: PartViewProps): JSX.Element { const theme = useTheme<MD3Theme>(); switch (props.part.kind) {
  case 'markdown': return <View style={styles.assistantBlock}>{props.part.blocks.map((block, index) => block.kind === 'heading' ? <Text key={`${props.part.id}:h:${index}`} variant="titleLarge" style={[styles.markdownHeading, { color: theme.colors.onSurface }]}>{block.text}</Text> : block.kind === 'bullet' ? <View key={`${props.part.id}:b:${index}`} style={styles.bulletRow}><Text style={[styles.bullet, { color: theme.colors.primary }]}>•</Text><Text style={[styles.markdownText, { color: theme.colors.onSurface }]}>{block.text}</Text></View> : block.kind === 'code' ? <View key={`${props.part.id}:c:${index}`} style={[styles.codeBlock, { backgroundColor: theme.colors.surfaceVariant }]}><Text style={[styles.codeLanguage, { color: theme.colors.primary }]}>{block.language || '代码'}</Text><Text selectable style={[styles.codeText, { color: theme.colors.onSurfaceVariant }]}>{block.text}</Text></View> : <Text key={`${props.part.id}:p:${index}`} style={[styles.markdownText, { color: theme.colors.onSurface }]}>{block.text}</Text>)}</View>;
  case 'reasoning': return <Pressable accessibilityRole="button" onPress={() => props.onToggleReasoning(props.part.id)} style={[styles.reasoningRow, { borderColor: theme.colors.outlineVariant }]}><MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="head-lightbulb-outline" size={22} /><Text style={styles.reasoningTitle}>思考</Text><View style={styles.toolbarSpacer} /><MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name={props.openReasoning ? 'chevron-up' : 'chevron-down'} size={22} />{props.openReasoning ? <Text style={[styles.reasoningText, { color: theme.colors.onSurfaceVariant }]}>{props.part.content}</Text> : null}</Pressable>;
  case 'tool': return <ToolCard part={props.part} />;
} }

function ToolCard({ part }: { readonly part: Extract<ChatPartViewModel, { kind: 'tool' }> }): JSX.Element { const theme = useTheme<MD3Theme>(); const icon = part.status === 'error' ? 'alert-circle-outline' : part.status === 'success' ? 'check-circle-outline' : 'progress-clock'; const color = part.status === 'error' ? theme.colors.error : theme.colors.primary; return <MaterialSurface elevation={1} shape="medium" tone="surfaceContainerLow" style={styles.toolCard}><View style={styles.toolHeader}><MaterialCommunityIcons color={color} name={icon} size={22} /><Text style={[styles.toolName, { color: theme.colors.onSurface }]}>{part.name}</Text><View style={styles.toolbarSpacer} /><Text variant="labelMedium" style={{ color }}>{toolStatusLabel(part.status)}</Text></View>{part.formattedInput.length > 0 ? <Text selectable style={[styles.toolInput, { color: theme.colors.onSurfaceVariant }]}>{part.formattedInput}</Text> : null}{part.output !== undefined ? <Text selectable style={[styles.toolOutput, { color: theme.colors.onSurface }]}>{part.output}</Text> : null}{part.error !== undefined ? <Text selectable style={[styles.toolError, { color: theme.colors.error }]}>{part.error}</Text> : null}</MaterialSurface>; }

function EmptyTranscript(props: { readonly status: string }): JSX.Element { const theme = useTheme<MD3Theme>(); return <View style={styles.emptyTranscript}><MaterialCommunityIcons color={theme.colors.outline} name={props.status === 'loading' ? 'cloud-sync-outline' : 'message-text-outline'} size={34} /><Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>{props.status === 'loading' ? '正在同步会话' : '等待你的第一条消息'}</Text></View>; }

interface ApprovalSheetProps { readonly approval: PendingApprovalViewModel | undefined; readonly onClose: () => void; readonly onResolve: (decision: 'allow' | 'deny') => Promise<void> }
function ApprovalSheet(props: ApprovalSheetProps): JSX.Element { const theme = useTheme<MD3Theme>(); const [resolving, setResolving] = useState(false); if (props.approval === undefined) return <></>; const resolve = async (decision: 'allow' | 'deny'): Promise<void> => { setResolving(true); try { await props.onResolve(decision); } finally { setResolving(false); } }; return <Modal animationType="slide" onRequestClose={props.onClose} transparent visible><View style={styles.sheetBackdrop}><Pressable accessibilityLabel="关闭权限请求" onPress={props.onClose} style={StyleSheet.absoluteFill} /><GlassPanel blurIntensity={82} glassEffectStyle="regular" materialElevation={5} materialShape="extraLarge" style={styles.sheet}><View style={[styles.sheetHandle, { backgroundColor: theme.colors.outline }]} /><Text variant="headlineSmall" style={styles.sheetTitle}>权限请求</Text><Text style={[styles.sheetDescription, { color: theme.colors.onSurfaceVariant }]}>允许在 {props.approval.hostName} 上执行此工具？</Text><View style={[styles.requestIdentity, { backgroundColor: theme.colors.surfaceVariant }]}><MaterialCommunityIcons color={theme.colors.primary} name="wrench-outline" size={22} /><View style={styles.requestCopy}><Text style={styles.requestTool}>{props.approval.displayName}</Text><Text style={[styles.requestWorkspace, { color: theme.colors.onSurfaceVariant }]}>{props.approval.workspaceName}</Text></View></View><Text selectable style={[styles.requestInput, { backgroundColor: theme.colors.surfaceVariant, color: theme.colors.onSurfaceVariant }]}>{props.approval.normalizedInput}</Text><View style={styles.sheetActions}><Button disabled={resolving} mode="outlined" onPress={() => void resolve('deny')} style={styles.sheetButton}>拒绝</Button><Button disabled={resolving} icon="check" mode="contained" onPress={() => void resolve('allow')} style={styles.sheetButton}>允许</Button></View></GlassPanel></View></Modal>; }

interface InputSheetProps { readonly input: PendingInputViewModel | undefined; readonly onClose: () => void; readonly onResolve: (answers: Readonly<Record<string, string>> | undefined) => Promise<void> }
function InputSheet(props: InputSheetProps): JSX.Element { const theme = useTheme<MD3Theme>(); const [answers, setAnswers] = useState<Readonly<Record<string, readonly string[]>>>({}); const [custom, setCustom] = useState<Readonly<Record<string, string>>>({}); const [resolving, setResolving] = useState(false); useEffect(() => { setAnswers({}); setCustom({}); }, [props.input?.id]); if (props.input === undefined) return <></>; const toggleOption = (questionKey: string, label: string, multiSelect: boolean): void => { setAnswers((current) => { const previous = current[questionKey] ?? []; if (!multiSelect) return { ...current, [questionKey]: [label] }; return { ...current, [questionKey]: previous.includes(label) ? previous.filter((value) => value !== label) : [...previous, label] }; }); }; const submit = async (): Promise<void> => { if (props.input === undefined) return; const output = buildStructuredInputAnswers(props.input, answers, custom); setResolving(true); try { await props.onResolve(output); } finally { setResolving(false); } }; return <Modal animationType="slide" onRequestClose={props.onClose} transparent visible><View style={styles.sheetBackdrop}><Pressable accessibilityLabel="关闭问题" onPress={props.onClose} style={StyleSheet.absoluteFill} /><GlassPanel blurIntensity={82} glassEffectStyle="regular" materialElevation={5} materialShape="extraLarge" style={styles.sheet}><View style={[styles.sheetHandle, { backgroundColor: theme.colors.outline }]} /><Text variant="headlineSmall" style={styles.sheetTitle}>需要你的输入</Text><Text style={[styles.sheetDescription, { color: theme.colors.onSurfaceVariant }]}>Cloud 正在等待你回答以下问题</Text>{props.input.questions.map((question, index) => <View key={`${props.input?.id}:question:${index}`} style={styles.questionBlock}><Text variant="labelLarge" style={{ color: theme.colors.primary }}>{question.header}</Text><Text style={styles.questionText}>{question.question}</Text>{question.options.map((option) => { const selected = answers[question.question]?.includes(option.label) === true; return <Pressable key={option.label} accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'} accessibilityState={{ checked: selected }} onPress={() => toggleOption(question.question, option.label, question.multiSelect)} style={[styles.optionRow, selected ? { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryContainer } : { borderColor: theme.colors.outlineVariant }]}><MaterialCommunityIcons color={selected ? theme.colors.primary : theme.colors.outline} name={selected ? (question.multiSelect ? 'checkbox-marked' : 'radiobox-marked') : (question.multiSelect ? 'checkbox-blank-outline' : 'radiobox-blank')} size={22} /><View style={styles.optionCopy}><Text style={styles.optionLabel}>{option.label}</Text><Text style={[styles.optionDescription, { color: theme.colors.onSurfaceVariant }]}>{option.description}</Text></View></Pressable>; })}<NativeTextInput accessibilityLabel={`${question.header} 自由输入`} onChangeText={(value) => setCustom((current) => ({ ...current, [question.question]: value }))} placeholder="或输入自定义回答" placeholderTextColor={theme.colors.onSurfaceVariant} style={[styles.customInput, { borderColor: theme.colors.outlineVariant, color: theme.colors.onSurface }]} value={custom[question.question] ?? ''} /></View>)}<View style={styles.sheetActions}><Button disabled={resolving} mode="outlined" onPress={() => void props.onResolve(undefined)} style={styles.sheetButton}>取消</Button><Button disabled={resolving} icon="send" mode="contained" onPress={() => void submit()} style={styles.sheetButton}>提交回答</Button></View></GlassPanel></View></Modal>; }

function toolStatusLabel(status: Extract<ChatPartViewModel, { kind: 'tool' }>['status']): string { switch (status) { case 'running': return '运行中'; case 'ready': return '等待执行'; case 'success': return '已完成'; case 'error': return '失败'; } }
function connectionColor(status: 'online' | 'degraded' | 'offline', theme: MD3Theme): string { if (status === 'online') return theme.colors.primary; if (status === 'degraded') return theme.colors.tertiary; return theme.colors.outline; }

const styles = StyleSheet.create({
  safe: { flex: 1 }, flex: { flex: 1 }, headerChrome: { marginHorizontal: 12, marginTop: 4, paddingHorizontal: 8, paddingVertical: 6 }, headerRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center' }, headerIdentity: { flex: 1, alignItems: 'center', gap: 1 }, brand: { fontWeight: '800' }, chatTitle: { maxWidth: '78%', fontSize: 13 }, contextRow: { minHeight: 29, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 7 }, contextChip: { minWidth: 0, flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 4 }, contextText: { maxWidth: 130, fontSize: 12 }, contextDot: { width: 3, height: 3, borderRadius: 2 }, connectionStatus: { flexDirection: 'row', alignItems: 'center', gap: 5 }, statusDot: { width: 8, height: 8, borderRadius: 4 }, statusBanner: { marginHorizontal: 18, marginTop: 8, minHeight: 46, paddingLeft: 12, paddingRight: 6, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 7 }, statusBannerText: { flex: 1, fontSize: 12, lineHeight: 17 }, notice: { marginHorizontal: 18, marginTop: 8, minHeight: 42, paddingHorizontal: 11, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 7 }, noticeText: { flex: 1, fontSize: 12 }, errorBanner: { marginHorizontal: 18, marginTop: 8, minHeight: 42, paddingLeft: 11, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 7 }, errorText: { flex: 1, fontSize: 12 }, transcript: { paddingHorizontal: 18, paddingTop: 18, gap: 16 }, promptRow: { alignItems: 'flex-end' }, promptBubble: { maxWidth: '84%', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 18, borderBottomRightRadius: 6 }, promptText: { fontSize: 17, lineHeight: 26 }, failureCard: { marginHorizontal: 8, padding: 13, borderWidth: StyleSheet.hairlineWidth }, failureContent: { gap: 8 }, failureHeader: { minHeight: 24, flexDirection: 'row', alignItems: 'center', gap: 8 }, failureLabel: { fontSize: 15, fontWeight: '700' }, failureMessage: { fontSize: 14, lineHeight: 21 }, assistantBlock: { paddingHorizontal: 8, gap: 9 }, markdownText: { fontSize: 17, lineHeight: 27 }, markdownHeading: { marginTop: 4, fontWeight: '700' }, bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 }, bullet: { fontSize: 21 }, codeBlock: { padding: 12, borderRadius: 9, gap: 6 }, codeLanguage: { fontSize: 11, fontWeight: '700' }, codeText: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 20 }, reasoningRow: { marginHorizontal: 8, minHeight: 50, paddingHorizontal: 12, paddingVertical: 11, borderWidth: StyleSheet.hairlineWidth, borderRadius: 13, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }, reasoningTitle: { fontSize: 16, fontWeight: '700' }, reasoningText: { width: '100%', paddingTop: 4, paddingLeft: 30, fontSize: 14, lineHeight: 22 }, toolCard: { marginHorizontal: 8, padding: 13, gap: 9 }, toolHeader: { minHeight: 25, flexDirection: 'row', alignItems: 'center', gap: 8 }, toolName: { fontSize: 16, fontWeight: '700' }, toolInput: { padding: 9, borderRadius: 7, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 18 }, toolOutput: { paddingTop: 3, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, lineHeight: 18 }, toolError: { fontSize: 13, lineHeight: 19 }, emptyTranscript: { flex: 1, minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 10 }, emptyText: { fontSize: 15 }, composerShell: { marginHorizontal: 12, padding: 11, paddingBottom: 7 }, composerInput: { minHeight: 58, maxHeight: 150, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 4, fontSize: 17, lineHeight: 25, textAlignVertical: 'top' }, composerToolbar: { minHeight: 47, flexDirection: 'row', alignItems: 'center', gap: 2 }, toolbarSpacer: { flex: 1 }, modelChip: { minWidth: 0, maxWidth: '48%', minHeight: 44, flexShrink: 1, borderRadius: 22, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 5 }, modelText: { minWidth: 0, flexShrink: 1, fontSize: 13, fontWeight: '600' }, menuContent: { maxHeight: 280 }, composerActivity: { position: 'absolute', right: 22, top: 18 }, sheetBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(20,26,38,0.22)' }, sheet: { maxHeight: '88%', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, borderTopLeftRadius: 28, borderTopRightRadius: 28, gap: 11 }, sheetHandle: { alignSelf: 'center', width: 42, height: 5, borderRadius: 3, marginBottom: 4 }, sheetTitle: { fontWeight: '800' }, sheetDescription: { fontSize: 15, lineHeight: 22 }, requestIdentity: { minHeight: 58, padding: 11, borderRadius: 11, flexDirection: 'row', alignItems: 'center', gap: 10 }, requestCopy: { flex: 1, gap: 3 }, requestTool: { fontSize: 16, fontWeight: '700' }, requestWorkspace: { fontSize: 13 }, requestInput: { maxHeight: 160, padding: 12, borderRadius: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 20 }, sheetActions: { flexDirection: 'row', gap: 10, marginTop: 4 }, sheetButton: { flex: 1 }, questionBlock: { gap: 7 }, questionText: { fontSize: 16, lineHeight: 23, fontWeight: '600' }, optionRow: { minHeight: 54, paddingHorizontal: 11, paddingVertical: 8, borderWidth: 1, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 9 }, optionCopy: { flex: 1, gap: 2 }, optionLabel: { fontSize: 15, fontWeight: '600' }, optionDescription: { fontSize: 12, lineHeight: 17 }, customInput: { minHeight: 44, paddingHorizontal: 11, borderWidth: 1, borderRadius: 10, fontSize: 15 },
});

export function parseChatRouteParam(value: string | string[] | undefined): ChatUri | undefined { const candidate = Array.isArray(value) ? value[0] : value; if (candidate === undefined) return undefined; try { return parseChatUri(candidate); } catch { return undefined; } }
