import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ComponentProps, type JSX, type RefObject } from 'react';
import {
  AccessibilityInfo,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  TextInput as NativeTextInput,
  View,
  type ListRenderItemInfo, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type TextLayoutEventData, type TextStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ActivityIndicator, Button, IconButton, Text, useTheme, type MD3Theme } from 'react-native-paper';
import { EnrichedMarkdownText } from 'react-native-enriched-markdown';

import { GlassPanel } from '../../ui/glass/GlassPanel';
import { GlassSurface } from '../../ui/glass/GlassSurface';
import { BottomSheetFrame } from '../../ui/motion/BottomSheetMotion';
import { useCloudActions, useCloudFrameSelector, useCloudSelector } from '../runtime/CloudRuntimeProvider';
import { selectRootCatalog, type CloudRuntimeState } from '../runtime/runtimeStore';
import {
  buildStructuredInputAnswers,
  createChatViewModelSelector,
  type ChatPartViewModel,
  type ChatTurnViewModel,
  type ChatViewModel,
  type PendingApprovalViewModel,
  type PendingInputViewModel,
} from './chatSelectors';
import { parseChatUri, type ChatUri } from '../../protocol/resourceUri';
import type { HostPermissionMode, HostSlashCommand } from '../../protocol/hostWire';
import { insertSlashCommand, type ComposerTextSelection } from './chatCommands';
import { shouldShowDeferredTranscriptLoading } from './chatTranscript';
import {
  atBottomFromMetrics,
  chatBottomOffset,
  shouldCommitChatBottomMeasurement,
  shouldFollowActiveStream,
  type ChatScrollMetrics,
} from './chatScroll';
import { nextRequestSheet, type RequestSheetKind } from './sheetCoordinator';
import { copyMessageText } from './messageClipboard';
import { processContentMaxHeight, shouldShowPromptExpand, USER_PROMPT_MAX_LINES } from './messagePresentation';

type ConfigPicker = 'model' | 'effort' | 'permission' | undefined;
interface ConfigOption { readonly id: string; readonly title: string; readonly description?: string }

export interface ChatScreenProps {
  readonly chatUri: ChatUri;
  /** Native-stack transitionEnd has fired for the currently focused route. */
  readonly navigationReady: boolean;
}

export default function ChatScreen(props: ChatScreenProps): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme<MD3Theme>();
  const actions = useCloudActions();
  const projectChat = useMemo(createChatViewModelSelector, []);
  const projectionUriRef = useRef<ChatUri | undefined>(undefined);
  if (projectionUriRef.current !== props.chatUri) projectionUriRef.current = undefined;
  const projectionReady = projectionUriRef.current === props.chatUri;
  const [, requestProjection] = useState(0);
  useEffect(() => {
    if (!props.navigationReady) return;
    let active = true;
    // Native-stack transitionEnd is the navigation completion signal. A single
    // frame gives that event a chance to return before the potentially large
    // transcript projection runs; unlike InteractionManager, this is explicit
    // and cancellable and does not claim to observe native animation handles.
    const frame = requestAnimationFrame(() => {
      if (!active) return;
      projectionUriRef.current = props.chatUri;
      requestProjection((value) => value + 1);
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
    };
  }, [props.chatUri, props.navigationReady]);
  const selectChat = useCallback((state: CloudRuntimeState) => projectChat({
      chatUri: props.chatUri,
      chatState: projectionReady ? selectChatState(state, props.chatUri) : undefined,
      // Catalog projection is small and keeps the real title/workspace in the
      // first frame; only the potentially long chat transcript is deferred.
      catalog: selectRootCatalog(state),
    }), [projectionReady, projectChat, props.chatUri]);
  const view = useCloudFrameSelector(selectChat);
  const syncStatus = useCloudSelector((state) => state.sync.status);
  const chatOperationError = useCloudSelector((state) => state.chatOperationError);
  const subscribeError = useCloudSelector((state) => (
    state.operationError?.operation === 'subscribe' && state.operationError.chatUri === props.chatUri
      ? state.operationError
      : undefined
  ));
  const chatSubscription = useCloudSelector((state) => state.chatSubscriptions[String(props.chatUri)]);
  const subscribeFailureCode = chatSubscription?.status === 'error' ? chatSubscription.code : subscribeError?.code;
  // A known catalog session has a loading view before the route effect gets a
  // chance to publish its per-chat request state. Keep that first frame honest
  // without treating an already materialized snapshot as loading.
  const chatLoading = !projectionReady
    || chatSubscription?.status === 'loading'
    || (chatSubscription === undefined && view.status === 'loading');
  const draftRef = useRef('');
  const hasDraftRef = useRef(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [sending, setSending] = useState(false);
  const [awaitingSince, setAwaitingSince] = useState<string | undefined>();
  const [stopping, setStopping] = useState(false);
  const [rewindingTurnId, setRewindingTurnId] = useState<string | undefined>();
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [commands, setCommands] = useState<readonly HostSlashCommand[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [configPicker, setConfigPicker] = useState<ConfigPicker>();
  const [approvalId, setApprovalId] = useState<string | undefined>();
  const [inputId, setInputId] = useState<string | undefined>();
  const [dismissedApprovalId, setDismissedApprovalId] = useState<string | undefined>();
  const [dismissedInputId, setDismissedInputId] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [requestSheet, setRequestSheet] = useState<RequestSheetKind>();
  const [reduceMotion, setReduceMotion] = useState(false);
  const composerInputRef = useRef<NativeTextInput>(null);
  const pendingPermissionPickerRef = useRef(false);
  const mountedRef = useRef(true);
  const requestSheetRef = useRef<RequestSheetKind>(undefined);
  const requestSheetClosingRef = useRef<RequestSheetKind>(undefined);
  const desiredRequestSheetRef = useRef<RequestSheetKind>(undefined);
  const transcriptRef = useRef<FlatList<ChatTurnViewModel>>(null);
  // The first render needs a stable safe-area-aware inset before the overlay
  // has reported its measured height. The later onLayout value includes any
  // visible connection/error banners.
  const topChromeFallback = insets.top + 52;
  const [topChromeHeight, setTopChromeHeight] = useState(topChromeFallback);
  // Do not assume a long, initially loaded history is at its end.
  const atBottomRef = useRef(false);
  const bottomStateMeasuredRef = useRef(false);
  const scrollMetricsRef = useRef<ChatScrollMetrics>({ contentHeight: 0, offsetY: 0, viewportHeight: 0 });
  const activeReplyRef = useRef(false);
  const programmaticScrollPendingRef = useRef(false);
  const userScrollInProgressRef = useRef(false);
  const userScrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [composerHeight, setComposerHeight] = useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const composerSelectionRef = useRef<ComposerTextSelection>({ start: 0, end: 0 });

  useEffect(() => {
    setTopChromeHeight(topChromeFallback);
  }, [topChromeFallback]);

  const updateTopChromeHeight = useCallback((height: number): void => {
    const nextHeight = Math.max(topChromeFallback, Math.ceil(height));
    setTopChromeHeight((current) => current === nextHeight ? current : nextHeight);
  }, [topChromeFallback]);

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
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingPermissionPickerRef.current = false;
    };
  }, []);
  useEffect(() => () => { if (userScrollIdleTimerRef.current !== undefined) clearTimeout(userScrollIdleTimerRef.current); }, []);

  const activeApproval = view.pendingApprovals.find((candidate) => candidate.id === approvalId)
    ?? (approvalId === undefined ? view.pendingApprovals.find((candidate) => candidate.id !== dismissedApprovalId) : undefined);
  const activeInput = view.pendingInputs.find((candidate) => candidate.id === inputId)
    ?? (inputId === undefined ? view.pendingInputs.find((candidate) => candidate.id !== dismissedInputId) : undefined);
  const desiredRequestSheet: RequestSheetKind = activeApproval === undefined ? (activeInput === undefined ? undefined : 'input') : 'approval';
  desiredRequestSheetRef.current = desiredRequestSheet;

  const handleRequestSheetDismissed = useCallback((kind: 'approval' | 'input'): void => {
    if (!mountedRef.current || requestSheetClosingRef.current !== kind) return;
    requestSheetClosingRef.current = undefined;
    requestSheetRef.current = undefined;
    const latest = desiredRequestSheetRef.current;
    if (latest === undefined) {
      setRequestSheet(undefined);
      return;
    }
    requestSheetRef.current = latest;
    setRequestSheet(latest);
  }, []);
  const handleApprovalSheetDismissed = useCallback((): void => handleRequestSheetDismissed('approval'), [handleRequestSheetDismissed]);
  const handleInputSheetDismissed = useCallback((): void => handleRequestSheetDismissed('input'), [handleRequestSheetDismissed]);

  useEffect(() => {
    if (requestSheetClosingRef.current !== undefined) return;
    const transition = nextRequestSheet(requestSheetRef.current, desiredRequestSheet);
    if (!transition.dismissCurrent) {
      if (requestSheetRef.current !== transition.show) {
        requestSheetRef.current = transition.show;
        setRequestSheet(transition.show);
      }
      return;
    }
    // Keep the current kind in requestSheetRef until its native Modal reports
    // dismissal. A new approval/input sheet is mounted only from that signal.
    requestSheetClosingRef.current = requestSheetRef.current;
    setRequestSheet(undefined);
  }, [desiredRequestSheet]);

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
  useEffect(() => {
    if (view.activeTurn !== undefined) setAwaitingSince(undefined);
  }, [view.activeTurn]);

  const send = useCallback(async (): Promise<void> => {
    const prompt = draftRef.current.trim();
    if (prompt.length === 0 || sending || syncStatus !== 'connected') return;
    setSending(true);
    try {
      const result = await actions.sendChat({ chatUri: props.chatUri, prompt });
      if (result.status === 'accepted') {
        draftRef.current = '';
        hasDraftRef.current = false;
        setHasDraft(false);
        composerInputRef.current?.clear();
        setAwaitingSince(new Date().toISOString());
      }
    } finally { setSending(false); }
  }, [actions, props.chatUri, sending, syncStatus]);

  const stop = useCallback(async (): Promise<void> => {
    const turnId = view.activeTurn?.id;
    if (turnId === undefined || stopping) return;
    setStopping(true);
    try { await actions.interruptChat({ chatUri: props.chatUri, turnId }); } finally { setStopping(false); }
  }, [actions, props.chatUri, stopping, view.activeTurn?.id]);

  const rewind = useCallback((turn: ChatTurnViewModel): void => {
    if (syncStatus !== 'connected' || sending || stopping || rewindingTurnId !== undefined || turn.status === 'active') return;
    const applyRewind = async (mode: 'conversation' | 'conversation_and_files'): Promise<void> => {
      setRewindingTurnId(turn.id);
      try {
        const result = await actions.rewindChat({ chatUri: props.chatUri, turnId: turn.id, mode });
        if (result.status !== 'accepted') return;
        draftRef.current = turn.prompt;
        hasDraftRef.current = turn.prompt.trim().length > 0;
        setHasDraft(hasDraftRef.current);
        composerInputRef.current?.setNativeProps({ text: turn.prompt });
        composerSelectionRef.current = { start: turn.prompt.length, end: turn.prompt.length };
        composerInputRef.current?.focus();
      } finally {
        setRewindingTurnId(undefined);
      }
    };
    Alert.alert(
      '是否撤回到该消息？',
      '该消息及其后的对话会被撤销，并将这条消息放回输入框。',
      [
        { text: '取消', style: 'cancel' },
        { text: '撤回会话', onPress: () => void applyRewind('conversation') },
        { text: '撤回消息和变更', style: 'destructive', onPress: () => void applyRewind('conversation_and_files') },
      ],
    );
  }, [actions, props.chatUri, rewindingTurnId, sending, stopping, syncStatus]);

  const openCommands = useCallback(async (): Promise<void> => {
    pendingPermissionPickerRef.current = false;
    Keyboard.dismiss();
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
  const copyMessage = useCallback(async (rawText: string): Promise<void> => {
    try {
      await copyMessageText(rawText);
      setNotice('已复制');
    } catch {
      setNotice('复制失败，请重试');
    }
  }, []);
  const turns = useMemo(() => view.activeTurn === undefined ? view.history : [...view.history, view.activeTurn], [view.activeTurn, view.history]);
  const active = view.activeTurn !== undefined && view.status === 'in_progress';
  const canChangeComposer = !sending && !stopping && !active;
  const composerDisabled = sending || stopping;

  const publishBottomState = useCallback((nextAtBottom: boolean): void => {
    if (nextAtBottom === atBottomRef.current && bottomStateMeasuredRef.current) return;
    bottomStateMeasuredRef.current = true;
    atBottomRef.current = nextAtBottom;
    setShowScrollToBottom(!nextAtBottom);
  }, []);
  const updateBottomState = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    scrollMetricsRef.current = { contentHeight: contentSize.height, viewportHeight: layoutMeasurement.height, offsetY: contentOffset.y };
    const nextAtBottom = atBottomFromMetrics(scrollMetricsRef.current);
    if (nextAtBottom === undefined) return;
    if (!shouldCommitChatBottomMeasurement({
      activeReply: active || activeReplyRef.current,
      currentlyAtBottom: atBottomRef.current,
      measuredAtBottom: nextAtBottom,
      programmaticScrollPending: programmaticScrollPendingRef.current,
      userInteracting: userScrollInProgressRef.current,
    })) return;
    if (nextAtBottom || userScrollInProgressRef.current) programmaticScrollPendingRef.current = false;
    publishBottomState(nextAtBottom);
  }, [active, publishBottomState]);
  const scrollToBottom = useCallback((): void => {
    const offset = chatBottomOffset(scrollMetricsRef.current);
    if (offset === undefined) return;
    programmaticScrollPendingRef.current = true;
    scrollMetricsRef.current = { ...scrollMetricsRef.current, offsetY: offset };
    publishBottomState(true);
    transcriptRef.current?.scrollToOffset({ offset, animated: false });
  }, [publishBottomState]);
  const beginUserScroll = useCallback((): void => {
    if (userScrollIdleTimerRef.current !== undefined) clearTimeout(userScrollIdleTimerRef.current);
    userScrollIdleTimerRef.current = undefined;
    userScrollInProgressRef.current = true;
    programmaticScrollPendingRef.current = false;
  }, []);
  const endUserDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    updateBottomState(event);
    if (userScrollIdleTimerRef.current !== undefined) clearTimeout(userScrollIdleTimerRef.current);
    userScrollIdleTimerRef.current = setTimeout(() => {
      userScrollIdleTimerRef.current = undefined;
      userScrollInProgressRef.current = false;
    }, 120);
  }, [updateBottomState]);
  const endUserMomentum = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    updateBottomState(event);
    userScrollInProgressRef.current = false;
  }, [updateBottomState]);
  const initializeTranscriptMetrics = useCallback((height: number): void => {
    const previousAtBottom = bottomStateMeasuredRef.current && atBottomRef.current;
    scrollMetricsRef.current = { ...scrollMetricsRef.current, viewportHeight: height };
    const atBottom = atBottomFromMetrics(scrollMetricsRef.current);
    // A keyboard/rotation viewport change is not a reader scroll: keep a live
    // reply anchored if the reader was already following its end.
    if ((active || activeReplyRef.current) && previousAtBottom) scrollToBottom();
    else if (atBottom !== undefined) publishBottomState(atBottom);
  }, [active, publishBottomState, scrollToBottom]);
  const updateContentMetrics = useCallback((width: number, height: number): void => {
    void width;
    const previousAtBottom = bottomStateMeasuredRef.current && atBottomRef.current;
    scrollMetricsRef.current = { ...scrollMetricsRef.current, contentHeight: height };
    const measured = atBottomFromMetrics(scrollMetricsRef.current);
    if (measured === undefined) return;
    if (shouldFollowActiveStream(active || activeReplyRef.current, previousAtBottom)) scrollToBottom();
    else publishBottomState(measured);
  }, [active, publishBottomState, scrollToBottom]);
  useEffect(() => {
    const wasActive = activeReplyRef.current;
    activeReplyRef.current = active;
    if (!wasActive || active || !atBottomRef.current) return;
    const frame = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(frame);
  }, [active, scrollToBottom]);

  const closeComposerMenus = useCallback((): void => {
    pendingPermissionPickerRef.current = false;
    setAttachmentMenuOpen(false);
  }, []);
  const openPermissionPicker = useCallback((): void => {
    pendingPermissionPickerRef.current = true;
    setAttachmentMenuOpen(false);
  }, []);
  const handleComposerPopoverDismissed = useCallback((): void => {
    if (!mountedRef.current || !pendingPermissionPickerRef.current) return;
    pendingPermissionPickerRef.current = false;
    setConfigPicker('permission');
  }, []);
  const selectCommand = useCallback((command: HostSlashCommand): void => {
    pendingPermissionPickerRef.current = false;
    const insertion = insertSlashCommand(draftRef.current, composerSelectionRef.current, command);
    setAttachmentMenuOpen(false);
    draftRef.current = insertion.text;
    const nextHasDraft = insertion.text.trim().length > 0;
    hasDraftRef.current = nextHasDraft;
    setHasDraft(nextHasDraft);
    composerSelectionRef.current = { start: insertion.cursor, end: insertion.cursor };
    requestAnimationFrame(() => {
      composerInputRef.current?.focus();
      composerInputRef.current?.setNativeProps({
        text: insertion.text,
        selection: { start: insertion.cursor, end: insertion.cursor },
      });
    });
  }, []);
  const selectedModel = view.models.find((model) => model.id === view.modelId);
  const pickerOptions = useMemo<readonly ConfigOption[]>(() => {
    if (configPicker === 'model') return view.models.map((model) => ({ id: model.id, title: model.displayName, ...(model.description === undefined ? {} : { description: model.description }) }));
    if (configPicker === 'effort') return (selectedModel?.supportedEffortLevels ?? []).map((effort) => ({ id: effort, title: effortDisplayName(effort) }));
    if (configPicker === 'permission') return view.permissionModes.map((mode) => ({ id: mode.id, title: mode.displayName, description: mode.description }));
    return [];
  }, [configPicker, selectedModel?.supportedEffortLevels, view.models, view.permissionModes]);
  const currentPickerValue = configPicker === 'model' ? view.modelId : configPicker === 'effort' ? view.effort : view.permissionMode;
  const selectConfig = useCallback(async (id: string): Promise<void> => {
    const picker = configPicker;
    if (picker === undefined) return;
    setConfigPicker(undefined);
    const result = await actions.configureChat({
      channel: props.chatUri,
      ...(picker === 'model' ? { modelId: id } : {}),
      ...(picker === 'effort' ? { effort: id as NonNullable<ChatViewModel['effort']> } : {}),
      ...(picker === 'permission' ? { permissionMode: id as HostPermissionMode } : {}),
    });
    if (result.status === 'accepted') setNotice('会话配置已更新');
  }, [actions, configPicker, props.chatUri]);
  const closeApproval = useCallback((): void => {
    if (activeApproval !== undefined) setDismissedApprovalId(activeApproval.id);
    setApprovalId(undefined);
  }, [activeApproval]);
  const resolveApproval = useCallback(async (decision: 'allow' | 'deny'): Promise<void> => {
    if (activeApproval === undefined) return;
    const result = decision === 'allow'
      ? await actions.allowApproval({ channel: props.chatUri, approvalId: activeApproval.id, decision: 'allow', decisionClassification: 'user_temporary' })
      : await actions.denyApproval({ channel: props.chatUri, approvalId: activeApproval.id, decision: 'deny', decisionClassification: 'user_reject', message: '用户拒绝执行此操作', interrupt: true });
    if (result.status === 'accepted' || result.status === 'already_resolved') {
      setDismissedApprovalId(activeApproval.id);
      setApprovalId(undefined);
      setNotice(result.status === 'already_resolved' ? '该权限请求已由其他客户端处理' : '权限决定已提交，等待 Host 确认');
    }
  }, [actions, activeApproval, props.chatUri]);
  const closeInput = useCallback((): void => {
    if (activeInput !== undefined) setDismissedInputId(activeInput.id);
    setInputId(undefined);
  }, [activeInput]);
  const resolveInput = useCallback(async (answers: Readonly<Record<string, string>> | undefined): Promise<void> => {
    if (activeInput === undefined) return;
    const result = await actions.resolveInput({ channel: props.chatUri, inputId: activeInput.id, ...(answers === undefined ? {} : { answers }) });
    if (result.status === 'accepted' || result.status === 'already_resolved') {
      setDismissedInputId(activeInput.id);
      setInputId(undefined);
      setNotice(result.status === 'already_resolved' ? '该问题已由其他客户端处理' : '回答已提交，等待 Host 继续');
    }
  }, [actions, activeInput, props.chatUri]);

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={8} style={styles.flex}>
        <View style={styles.flex}>
          <ChatTranscript
            awaitingSince={awaitingSince}
            bottomInset={Math.max(insets.bottom, 10)}
            composerHeight={composerHeight}
            failed={subscribeFailureCode !== undefined}
            initializeMetrics={initializeTranscriptMetrics}
            onContentSizeChange={updateContentMetrics}
            onMomentumScrollBegin={beginUserScroll}
            onMomentumScrollEnd={endUserMomentum}
            onCopy={(rawText) => void copyMessage(rawText)}
            onRewind={rewind}
            onScroll={updateBottomState}
            onScrollBeginDrag={beginUserScroll}
            onScrollEndDrag={endUserDrag}
            reduceMotion={reduceMotion}
            status={chatLoading ? 'loading' : view.status}
            topChromeInset={topChromeHeight}
            transcriptRef={transcriptRef}
            turns={turns}
          />
          {showScrollToBottom ? <Pressable accessibilityLabel="回到最新消息" accessibilityRole="button" onPress={scrollToBottom} style={[styles.scrollToBottom, { bottom: Math.max(insets.bottom, 10) + composerHeight + 12, backgroundColor: theme.colors.secondaryContainer }]}><MaterialCommunityIcons color={theme.colors.onSecondaryContainer} name="arrow-down" size={22} /></Pressable> : null}
          <View onLayout={(event) => { const height = Math.ceil(event.nativeEvent.layout.height); setComposerHeight((current) => current === height ? current : height); }} style={[styles.composerDock, { bottom: Math.max(insets.bottom, 10) }]}>
            <GlassPanel blurIntensity={72} glassEffectStyle="regular" materialElevation={3} materialShape="extraLarge" style={styles.composerShell}>
              <NativeTextInput accessibilityLabel="消息输入框" editable={!composerDisabled} maxLength={10000} multiline onChangeText={(text) => { draftRef.current = text; const nextHasDraft = text.trim().length > 0; if (nextHasDraft !== hasDraftRef.current) { hasDraftRef.current = nextHasDraft; setHasDraft(nextHasDraft); } }} onSelectionChange={(event) => { composerSelectionRef.current = event.nativeEvent.selection; }} onSubmitEditing={() => void send()} placeholder="给 Cloud 发送消息" placeholderTextColor={theme.colors.onSurfaceVariant} ref={composerInputRef} style={[styles.composerInput, { color: theme.colors.onSurface }]} />
              <View style={styles.composerToolbar}>
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
                <View style={styles.toolbarSpacer} />
                {view.modelDisplayName === undefined ? null : (
                  <Pressable accessibilityLabel={`切换当前会话模型：${view.modelDisplayName}`} disabled={!canChangeComposer} onPress={() => { Keyboard.dismiss(); setConfigPicker('model'); }} style={styles.modelChip}>
                    <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.modelText, { color: theme.colors.onSurfaceVariant }]}>{view.modelDisplayName}</Text>
                  </Pressable>
                )}
                {(selectedModel?.supportedEffortLevels.length ?? 0) === 0 ? null : (
                  <Pressable accessibilityLabel={`切换当前会话思考强度：${view.effort === undefined ? '默认' : effortDisplayName(view.effort)}`} disabled={!canChangeComposer} onPress={() => { Keyboard.dismiss(); setConfigPicker('effort'); }} style={styles.strengthChip}>
                    <Text style={[styles.strengthText, { color: theme.colors.onSurfaceVariant }]}>{view.effort === undefined ? '默认' : effortDisplayName(view.effort)}</Text>
                  </Pressable>
                )}
                {active ? (
                  <Pressable accessibilityLabel="停止运行" accessibilityRole="button" disabled={stopping} onPress={() => void stop()} style={({ pressed }) => [styles.sendButton, { backgroundColor: theme.colors.error }, pressed ? styles.sendPressed : null]}>
                    {stopping && !reduceMotion ? <ActivityIndicator color={theme.colors.onError} size="small" /> : <MaterialCommunityIcons color={theme.colors.onError} name="stop" size={20} />}
                  </Pressable>
                ) : (
                  <Pressable accessibilityLabel="发送消息" accessibilityRole="button" accessibilityState={{ disabled: !hasDraft || sending || syncStatus !== 'connected' }} disabled={!hasDraft || sending || syncStatus !== 'connected'} onPress={() => void send()} style={({ pressed }) => [styles.sendButton, { backgroundColor: !hasDraft || sending || syncStatus !== 'connected' ? theme.colors.outlineVariant : theme.colors.primary }, pressed && !reduceMotion ? styles.sendPressed : null]}>
                    {sending && !reduceMotion ? <ActivityIndicator color={theme.colors.onPrimary} size="small" /> : <MaterialCommunityIcons color={!hasDraft || sending || syncStatus !== 'connected' ? theme.colors.onSurfaceVariant : theme.colors.onPrimary} name={sending ? 'clock-outline' : 'arrow-up'} size={21} />}
                  </Pressable>
                )}
              </View>
            </GlassPanel>
          </View>
          <View
            collapsable={false}
            onLayout={(event) => updateTopChromeHeight(event.nativeEvent.layout.height)}
            pointerEvents="box-none"
            style={styles.topChrome}
            testID="chat-top-chrome"
          >
            <View style={styles.topChromeHeader}>
              <GlassSurface
                blurIntensity={48}
                glassEffectStyle="regular"
                materialElevation={1}
                materialShape="none"
                materialTone="surfaceContainerLow"
                style={styles.topChromeMaterial}
              />
              <View style={[styles.topChromeContent, { paddingTop: insets.top }]}>
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
                      {[view.workspaceName, view.modelDisplayName, view.modelId === undefined ? undefined : `强度 ${effortDisplayName(view.effort)}`].filter((value): value is string => value !== undefined && value.length > 0).join(' · ')}
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
              <View style={[styles.topChromeEdge, { backgroundColor: theme.colors.outlineVariant }]} />
            </View>
            {syncStatus !== 'connected' ? <View style={[styles.statusBanner, { backgroundColor: theme.colors.surfaceVariant }]}><MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="cloud-off-outline" size={18} /><Text style={[styles.statusBannerText, { color: theme.colors.onSurfaceVariant }]}>{syncStatus === 'reconnecting' ? '连接已断开，正在重新连接；当前内容保留在本机' : '当前未连接 Host，消息不会显示为已发送'}</Text><Button compact onPress={actions.retryConnection}>重试</Button></View> : null}
            {chatLoading ? <View accessibilityLiveRegion="polite" style={[styles.statusBanner, { backgroundColor: theme.colors.surfaceVariant }]}><ActivityIndicator color={theme.colors.onSurfaceVariant} size="small" /><Text style={[styles.statusBannerText, { color: theme.colors.onSurfaceVariant }]}>正在从 Host 同步会话</Text></View> : null}
            {subscribeFailureCode !== undefined ? <View accessibilityLiveRegion="assertive" style={[styles.errorBanner, { backgroundColor: theme.colors.errorContainer }]}><MaterialCommunityIcons color={theme.colors.onErrorContainer} name="alert-circle-outline" size={18} /><Text style={[styles.errorText, { color: theme.colors.onErrorContainer }]}>无法载入这个会话（{subscribeFailureCode}）</Text><Button compact onPress={() => void actions.subscribeChat(props.chatUri)}>重试</Button>{subscribeError !== undefined ? <IconButton accessibilityLabel="关闭错误" icon="close" onPress={actions.clearOperationError} size={22} /> : null}</View> : null}
            {chatOperationError !== undefined ? <View style={[styles.errorBanner, { backgroundColor: theme.colors.errorContainer }]}><MaterialCommunityIcons color={theme.colors.onErrorContainer} name="alert-circle-outline" size={18} /><Text style={[styles.errorText, { color: theme.colors.onErrorContainer }]}>操作未完成，请重试（{chatOperationError.code}）</Text><IconButton accessibilityLabel="关闭错误" icon="close" onPress={actions.clearChatOperationError} size={22} /></View> : null}
          </View>
        </View>
      </KeyboardAvoidingView>
      <ComposerCommandPopover commands={commands} currentPermission={view.permissionModes.find((mode) => mode.id === view.permissionMode)?.displayName ?? view.permissionMode} loading={commandsLoading} onClose={closeComposerMenus} onCommand={selectCommand} onDismiss={handleComposerPopoverDismissed} onPermission={openPermissionPicker} reduceMotion={reduceMotion} visible={attachmentMenuOpen} />
      <ConfigChoiceSheet currentValue={currentPickerValue} onClose={() => setConfigPicker(undefined)} onSelect={selectConfig} options={pickerOptions} reduceMotion={reduceMotion} title={configPicker === 'model' ? '选择模型' : configPicker === 'effort' ? '选择思考强度' : '权限设置'} visible={configPicker !== undefined} />
      <ApprovalSheet approval={requestSheet === 'approval' ? activeApproval : undefined} reduceMotion={reduceMotion} onClose={closeApproval} onDismiss={handleApprovalSheetDismissed} onResolve={resolveApproval} />
      <InputSheet input={requestSheet === 'input' ? activeInput : undefined} reduceMotion={reduceMotion} onClose={closeInput} onDismiss={handleInputSheetDismissed} onResolve={resolveInput} />
      {notice !== undefined ? (
        <Pressable accessibilityRole="button" accessibilityLabel="关闭提示" onPress={() => setNotice(undefined)} style={[styles.noticeToast, { top: topChromeHeight + 8, backgroundColor: theme.colors.onSurface }]}>
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

interface ChatTranscriptProps {
  readonly awaitingSince?: string;
  readonly bottomInset: number;
  readonly composerHeight: number;
  readonly failed: boolean;
  readonly initializeMetrics: (height: number) => void;
  readonly onContentSizeChange: (width: number, height: number) => void;
  readonly onMomentumScrollBegin: () => void;
  readonly onMomentumScrollEnd: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly onCopy: (rawText: string) => void;
  readonly onRewind: (turn: ChatTurnViewModel) => void;
  readonly onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly onScrollBeginDrag: () => void;
  readonly onScrollEndDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  readonly reduceMotion: boolean;
  readonly status: ChatViewModel['status'];
  readonly topChromeInset: number;
  readonly transcriptRef: RefObject<FlatList<ChatTurnViewModel> | null>;
  readonly turns: readonly ChatTurnViewModel[];
}

const ChatTranscript = memo(function ChatTranscript(props: ChatTranscriptProps): JSX.Element {
  // Streaming can outpace the display refresh rate. React may discard stale
  // intermediate projections while input and native scrolling stay urgent.
  const deferredTurns = useDeferredValue(props.turns);
  const showDeferredLoading = shouldShowDeferredTranscriptLoading(
    deferredTurns.length,
    props.turns.length,
    props.awaitingSince,
    props.failed,
  );
  const renderItem = useCallback(({ item }: ListRenderItemInfo<ChatTurnViewModel>) => (
    <TurnTranscriptItem onCopy={props.onCopy} onRewind={props.onRewind} reduceMotion={props.reduceMotion} turn={item} />
  ), [props.onCopy, props.onRewind, props.reduceMotion]);
  return (
    <FlatList
      contentContainerStyle={[styles.transcript, { paddingBottom: props.composerHeight + props.bottomInset + 20, paddingTop: props.topChromeInset + 10 }]}
      contentInsetAdjustmentBehavior="never"
      data={deferredTurns}
      initialNumToRender={8}
      keyExtractor={(item) => item.id}
      keyboardShouldPersistTaps="handled"
      ListEmptyComponent={props.awaitingSince === undefined ? <EmptyTranscript failed={props.failed} status={showDeferredLoading ? 'loading' : props.status} /> : null}
      ListFooterComponent={props.awaitingSince === undefined ? null : <PendingThinking startedAt={props.awaitingSince} />}
      maxToRenderPerBatch={6}
      onContentSizeChange={props.onContentSizeChange}
      onLayout={(event) => props.initializeMetrics(event.nativeEvent.layout.height)}
      onMomentumScrollBegin={props.onMomentumScrollBegin}
      onMomentumScrollEnd={props.onMomentumScrollEnd}
      onScroll={props.onScroll}
      onScrollBeginDrag={props.onScrollBeginDrag}
      onScrollEndDrag={props.onScrollEndDrag}
      ref={props.transcriptRef}
      removeClippedSubviews={Platform.OS === 'android'}
      renderItem={renderItem}
      scrollEventThrottle={32}
      scrollIndicatorInsets={{ top: props.topChromeInset }}
      showsVerticalScrollIndicator={false}
      updateCellsBatchingPeriod={32}
      windowSize={7}
    />
  );
});

const TurnTranscriptItem = memo(function TurnTranscriptItem({ turn, reduceMotion, onCopy, onRewind }: { readonly turn: ChatTurnViewModel; readonly reduceMotion: boolean; readonly onCopy: (rawText: string) => void; readonly onRewind: (turn: ChatTurnViewModel) => void }): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const markdownParts = turn.parts.filter((part): part is Extract<ChatPartViewModel, { kind: 'markdown' }> => part.kind === 'markdown');
  const hasStructuredProcess = turn.parts.some((part) => part.kind !== 'markdown');
  const finalAnswerId = hasStructuredProcess ? markdownParts.at(-1)?.id : undefined;
  const processParts = hasStructuredProcess
    ? turn.parts.filter((part) => part.kind !== 'markdown' || part.id !== finalAnswerId)
    : [];
  const answerParts = hasStructuredProcess ? markdownParts.filter((part) => part.id === finalAnswerId) : markdownParts;
  const [processOpen, setProcessOpen] = useState(turn.status === 'active');
  const [partOpen, setPartOpen] = useState<Readonly<Record<string, boolean>>>({});
  const elapsed = useElapsedLabel(turn.startedAt, turn.completedAt, turn.status === 'active');
  useEffect(() => {
    if (turn.status !== 'active') setProcessOpen(false);
  }, [turn.status]);
  const hasProcess = processParts.length > 0 || turn.status === 'active';
  return (
    <View style={styles.turnBlock}>
      <UserPromptMessage onCopy={onCopy} onRewind={() => onRewind(turn)} prompt={turn.prompt} reduceMotion={reduceMotion} status={turn.status} />
      {hasProcess ? (
        <View style={styles.processBlock}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: processOpen }} onPress={() => setProcessOpen((open) => !open)} style={({ pressed }) => [styles.processHeader, pressed && !reduceMotion ? styles.pressed : null]}>
            {turn.status === 'active' ? <ActivityIndicator color={theme.colors.onSurfaceVariant} size="small" /> : null}
            <Text style={[styles.processTitle, { color: theme.colors.onSurfaceVariant }]}>{turn.status === 'active' ? activeProcessTitle(turn.activity, elapsed) : elapsed ?? '思考过程'}</Text>
            <View style={styles.toolbarSpacer} />
            <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name={processOpen ? 'chevron-up' : 'chevron-down'} size={21} />
          </Pressable>
          {processOpen ? (
            <View style={[styles.processContent, { borderLeftColor: theme.colors.outlineVariant }]}>
              {processParts.length === 0 ? <Text style={[styles.processWaiting, { color: theme.colors.onSurfaceVariant }]}>正在等待 Host 返回思考或工具调用…</Text> : null}
              {processParts.map((part) => (
                <ProcessPart key={part.id} open={partOpen[part.id] === true} part={part} onToggle={() => setPartOpen((current) => ({ ...current, [part.id]: current[part.id] !== true }))} />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {answerParts.map((part) => turn.status === 'complete'
        ? <MarkdownAnswer key={part.id} content={part.content} onCopy={onCopy} />
        : <StreamingAnswer key={part.id} content={part.content} />)}
      {turn.status === 'failed' ? <FailureView message={turn.error ?? 'Host 未能完成这次请求，请稍后重试。'} /> : null}
    </View>
  );
});

interface UserPromptMessageProps {
  readonly onCopy: (rawText: string) => void;
  readonly onRewind: () => void;
  readonly prompt: string;
  readonly reduceMotion: boolean;
  readonly status: ChatTurnViewModel['status'];
}

const UserPromptMessage = memo(function UserPromptMessage(props: UserPromptMessageProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const [expanded, setExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const onFullTextLayout = useCallback((event: NativeSyntheticEvent<TextLayoutEventData>): void => {
    setHasOverflow(shouldShowPromptExpand(event.nativeEvent.lines.length));
  }, []);
  return (
    <View style={styles.promptMessage}>
      <View style={styles.promptRow}>
        <View style={[styles.promptBubble, { backgroundColor: theme.colors.onSurface }]}>
          {/* A full, invisible layout pass is required because a truncated Text cannot report true overflow. */}
          <NativeText accessibilityElementsHidden importantForAccessibility="no-hide-descendants" onTextLayout={onFullTextLayout} style={[styles.promptText, styles.promptMeasurement, { color: theme.colors.surface }]}>{props.prompt}</NativeText>
          <Text ellipsizeMode="tail" numberOfLines={expanded ? undefined : USER_PROMPT_MAX_LINES} selectable style={[styles.promptText, { color: theme.colors.surface }]}>{props.prompt}</Text>
        </View>
      </View>
      <View style={styles.messageActions}>
        <Pressable
          accessibilityLabel="复制用户消息"
          accessibilityRole="button"
          onPress={() => props.onCopy(props.prompt)}
          style={({ pressed }) => [styles.messageAction, pressed && !props.reduceMotion ? styles.pressed : null]}
        >
          <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="content-copy" size={18} />
        </Pressable>
        <Pressable
          accessibilityLabel="撤回到此消息"
          accessibilityRole="button"
          accessibilityState={{ disabled: props.status === 'active' }}
          disabled={props.status === 'active'}
          onPress={props.onRewind}
          style={({ pressed }) => [styles.messageAction, pressed && !props.reduceMotion ? styles.pressed : null]}
        >
          <MaterialCommunityIcons color={props.status === 'active' ? theme.colors.outline : theme.colors.onSurfaceVariant} name="history" size={19} />
        </Pressable>
        {hasOverflow ? (
          <Pressable
            accessibilityLabel={expanded ? '收起用户消息' : '展开用户消息'}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((value) => !value)}
            style={({ pressed }) => [styles.messageAction, pressed && !props.reduceMotion ? styles.pressed : null]}
          >
            <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name={expanded ? 'chevron-up' : 'chevron-down'} size={20} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

const StreamingAnswer = memo(function StreamingAnswer({ content }: { readonly content: string }): JSX.Element {
  const theme = useTheme<MD3Theme>();
  return <View style={styles.assistantBlock}><Text selectable style={[styles.streamingText, { color: theme.colors.onSurface }]}>{content}</Text></View>;
});

function PendingThinking({ startedAt }: { readonly startedAt: string }): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const elapsed = useElapsedLabel(startedAt, undefined, true);
  return <View style={styles.processBlock}><View style={styles.processHeader}><ActivityIndicator color={theme.colors.onSurfaceVariant} size="small" /><Text style={[styles.processTitle, { color: theme.colors.onSurfaceVariant }]}>{elapsed === undefined ? '正在思考' : `正在思考 · ${elapsed}`}</Text></View></View>;
}

function useElapsedLabel(startedAt: string, completedAt: string | undefined, running: boolean): string | undefined {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const started = Date.parse(startedAt);
  const ended = running ? now : completedAt === undefined ? Number.NaN : Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return undefined;
  const seconds = Math.floor((ended - started) / 1000);
  return `用时${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
}

function activeProcessTitle(activity: ChatTurnViewModel['activity'], elapsed: string | undefined): string {
  const title = activity === 'requesting_model'
    ? '正在请求 Claude'
    : activity === 'compacting_context'
      ? '正在压缩上下文'
      : '正在思考';
  return elapsed === undefined ? title : `${title} · ${elapsed}`;
}

// react-native-enriched-markdown@0.5.0 defaults latexMath to true. Math is
// deliberately disabled for this migration: it is unrelated to text
// selection/copy and would add iosMath/AndroidMath native dependencies and
// validation surface. Keep this explicit because the library's default can
// otherwise change the native build when this component is refactored.
const assistantMarkdownMd4cFlags = { underline: false, latexMath: false } as const;

const MarkdownAnswer = memo(function MarkdownAnswer({ content, onCopy }: { readonly content: string; readonly onCopy: (rawText: string) => void }): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const markdownStyle = useMemo(() => ({
    paragraph: { color: theme.colors.onSurface, fontSize: 16, lineHeight: 25, marginBottom: 10, marginTop: 0 },
    h1: { color: theme.colors.onSurface, fontSize: 26, fontWeight: 'bold', lineHeight: 34, marginBottom: 8, marginTop: 12 },
    h2: { color: theme.colors.onSurface, fontSize: 22, fontWeight: 'bold', lineHeight: 30, marginBottom: 7, marginTop: 10 },
    h3: { color: theme.colors.onSurface, fontSize: 19, fontWeight: 'bold', lineHeight: 27, marginBottom: 6, marginTop: 8 },
    h4: { color: theme.colors.onSurface, fontSize: 17, fontWeight: 'bold', lineHeight: 25, marginBottom: 5, marginTop: 7 },
    h5: { color: theme.colors.onSurface, fontSize: 16, fontWeight: 'bold', lineHeight: 24, marginBottom: 4, marginTop: 6 },
    h6: { color: theme.colors.onSurface, fontSize: 15, fontWeight: 'bold', lineHeight: 22, marginBottom: 4, marginTop: 5 },
    strong: { fontWeight: 'bold' as const },
    em: { fontStyle: 'italic' as const },
    strikethrough: { color: theme.colors.onSurfaceVariant },
    // Native enriched-markdown uses an empty family and zero size as the
    // inheritance sentinel for inline code. Keeping those fields absent lets
    // the parent paragraph/list provide the 16pt metrics while the library
    // supplies its platform system-monospace face, so wrapped inline code
    // stays on the same baseline instead of becoming a smaller tall span.
    code: { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant, color: theme.colors.onSurface },
    codeBlock: { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.outlineVariant, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, color: theme.colors.onSurface, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 18, marginBottom: 0, marginTop: 0, padding: 4 },
    blockquote: { backgroundColor: theme.colors.surfaceVariant, borderColor: theme.colors.primary, borderWidth: 3, color: theme.colors.onSurfaceVariant, gapWidth: 12 },
    list: { color: theme.colors.onSurface, fontSize: 16, lineHeight: 25, marginBottom: 8, marginLeft: 22, marginTop: 0, gapWidth: 8 },
    link: { color: theme.colors.primary, underline: true },
    thematicBreak: { color: theme.colors.outlineVariant, height: StyleSheet.hairlineWidth, marginBottom: 10, marginTop: 10 },
  }), [theme.colors]);
  return (
    <View style={styles.assistantBlock}>
      <EnrichedMarkdownText
        flavor="github"
        markdown={content}
        markdownStyle={markdownStyle}
        md4cFlags={assistantMarkdownMd4cFlags}
        onLinkPress={({ url }) => { void Linking.openURL(url); }}
        selectable
      />
      <MessageCopyAction accessibilityLabel="复制助手回复" onPress={() => onCopy(content)} />
    </View>
  );
});

function MessageCopyAction(props: { readonly accessibilityLabel: string; readonly onPress: () => void }): JSX.Element {
  const theme = useTheme<MD3Theme>();
  return (
    <Pressable accessibilityLabel={props.accessibilityLabel} accessibilityRole="button" onPress={props.onPress} style={[styles.messageAction, styles.assistantMessageAction]}>
      <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="content-copy" size={18} />
    </Pressable>
  );
}

function ProcessPart({ part, open, onToggle }: { readonly part: ChatPartViewModel; readonly open: boolean; readonly onToggle: () => void }): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const isTool = part.kind === 'tool';
  const isSystem = part.kind === 'system';
  const title = isTool ? part.name : isSystem ? part.title : part.kind === 'reasoning' ? '思考过程' : '过程说明';
  const status = isTool ? toolStatusLabel(part.status) : isSystem ? systemMessageLevelLabel(part.level) : undefined;
  const icon: ComponentProps<typeof MaterialCommunityIcons>['name'] = isTool
    ? 'wrench-outline'
    : isSystem
      ? systemMessageIcon(part.level)
      : part.kind === 'reasoning' ? 'head-lightbulb-outline' : 'text-box-outline';
  const accent = isSystem && part.level === 'error' ? theme.colors.error : theme.colors.onSurfaceVariant;
  return (
    <View style={[styles.processPart, { borderColor: theme.colors.outlineVariant, backgroundColor: theme.colors.surface }]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onToggle} style={styles.processPartHeader}>
        <MaterialCommunityIcons color={accent} name={icon} size={19} />
        <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.processPartTitle, { color: isSystem ? theme.colors.onSurfaceVariant : theme.colors.onSurface }]}>{title}</Text>
        <View style={styles.toolbarSpacer} />
        {status === undefined ? null : <Text style={[styles.processPartStatus, { color: theme.colors.onSurfaceVariant }]}>{status}</Text>}
        <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name={open ? 'chevron-up' : 'chevron-down'} size={19} />
      </Pressable>
      {open && part.kind === 'reasoning' ? <BoundedProcessContent content={part.content} lineHeight={21} textStyle={[styles.reasoningText, { color: theme.colors.onSurfaceVariant }]} /> : null}
      {open && part.kind === 'markdown' ? <Text selectable style={[styles.reasoningText, { color: theme.colors.onSurfaceVariant }]}>{part.content}</Text> : null}
      {open && part.kind === 'system' ? <BoundedProcessContent content={part.content} lineHeight={21} textStyle={[styles.reasoningText, { color: part.level === 'error' ? theme.colors.error : theme.colors.onSurfaceVariant }]} /> : null}
      {open && part.kind === 'tool' && part.formattedInput.length > 0 ? <BoundedProcessContent content={part.formattedInput} lineHeight={17} textStyle={[styles.toolInput, { backgroundColor: theme.colors.surfaceVariant, color: theme.colors.onSurfaceVariant }]} /> : null}
      {open && part.kind === 'tool' && part.output !== undefined ? <BoundedProcessContent content={part.output} lineHeight={17} textStyle={[styles.toolOutput, { color: theme.colors.onSurface }]} /> : null}
      {open && part.kind === 'tool' && part.error !== undefined ? <BoundedProcessContent content={part.error} lineHeight={19} textStyle={[styles.toolError, { color: theme.colors.error }]} /> : null}
    </View>
  );
}

function BoundedProcessContent(props: { readonly content: string; readonly lineHeight: number; readonly textStyle?: StyleProp<TextStyle> }): JSX.Element {
  const maxHeight = processContentMaxHeight(props.lineHeight);
  // Keep long tool/reasoning output inside the part so the transcript list remains usable.
  return (
    <ScrollView
      nestedScrollEnabled
      showsVerticalScrollIndicator
      style={[styles.boundedProcessScroll, { maxHeight }]}
    >
      <NativeText selectable style={props.textStyle}>{props.content}</NativeText>
    </ScrollView>
  );
}

function FailureView({ message }: { readonly message: string }): JSX.Element {
  const theme = useTheme<MD3Theme>();
  return (
    <GlassPanel materialElevation={1} materialShape="medium" materialTone="surfaceContainerLow" style={[styles.failureCard, { borderColor: theme.colors.error }]}>
      <View accessible accessibilityRole="alert" accessibilityLabel={`执行失败。${message}`} style={styles.failureContent}>
        <View style={styles.failureHeader}>
          <MaterialCommunityIcons color={theme.colors.error} name="alert-circle-outline" size={21} />
          <Text style={[styles.failureLabel, { color: theme.colors.error }]}>执行失败</Text>
        </View>
        <Text selectable style={[styles.failureMessage, { color: theme.colors.onSurface }]}>{message}</Text>
      </View>
    </GlassPanel>
  );
}

function EmptyTranscript(props: { readonly failed: boolean; readonly status: string }): JSX.Element { const theme = useTheme<MD3Theme>(); const loading = props.status === 'loading' && !props.failed; return <View style={styles.emptyTranscript}><MaterialCommunityIcons color={theme.colors.outline} name={props.failed ? 'message-alert-outline' : loading ? 'cloud-sync-outline' : 'message-text-outline'} size={34} /><Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>{props.failed ? '这个历史会话暂时无法从 Host 载入' : loading ? '正在同步会话' : '等待你的第一条消息'}</Text></View>; }

interface ComposerCommandPopoverProps {
  readonly commands: readonly HostSlashCommand[];
  readonly currentPermission?: string;
  readonly loading: boolean;
  readonly onClose: () => void;
  readonly onCommand: (command: HostSlashCommand) => void;
  readonly onDismiss: () => void;
  readonly onPermission: () => void;
  readonly reduceMotion: boolean;
  readonly visible: boolean;
}
function ComposerCommandPopover(props: ComposerCommandPopoverProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const insets = useSafeAreaInsets();
  return (
    <BottomSheetFrame onClose={props.onClose} onDismiss={props.onDismiss} panelStyle={styles.commandPopoverMotion} reduceMotion={props.reduceMotion} scrimStyle={styles.modalScrim} visible={props.visible}>
          <GlassPanel blurIntensity={82} containerStyle={styles.commandPopoverContainer} glassEffectStyle="regular" materialElevation={5} materialShape="extraLarge" style={[styles.commandPopover, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={[styles.sheetHandle, { backgroundColor: theme.colors.outline }]} />
            <Text variant="headlineSmall" style={styles.sheetTitle}>添加内容</Text>
            <ScrollView bounces={false} contentContainerStyle={styles.commandList} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator style={styles.commandScroll}>
              <CommandRow description={props.currentPermission ?? '由 Host 管理'} icon="shield-check-outline" onPress={props.onPermission} title="权限设置" />
              <View style={[styles.commandDivider, { backgroundColor: theme.colors.outlineVariant }]} />
              {props.loading ? <View style={styles.commandLoading}><ActivityIndicator size="small" /><Text style={{ color: theme.colors.onSurfaceVariant }}>正在从 Host 获取命令</Text></View> : null}
              {!props.loading && props.commands.length === 0 ? <Text style={[styles.commandEmpty, { color: theme.colors.onSurfaceVariant }]}>当前会话没有可用命令</Text> : null}
              {props.commands.map((command) => <CommandRow key={command.name} description={command.description || command.argumentHint} icon="slash-forward" onPress={() => props.onCommand(command)} title={`/${command.name}`} />)}
            </ScrollView>
          </GlassPanel>
    </BottomSheetFrame>
  );
}

function CommandRow(props: { readonly description: string; readonly icon: ComponentProps<typeof MaterialCommunityIcons>['name']; readonly onPress: () => void; readonly title: string }): JSX.Element {
  const theme = useTheme<MD3Theme>();
  return <Pressable onPress={props.onPress} style={({ pressed }) => [styles.commandRow, pressed ? styles.pressed : null]}><MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name={props.icon} size={20} /><View style={styles.commandCopy}><Text numberOfLines={1} style={[styles.commandTitle, { color: theme.colors.onSurface }]}>{props.title}</Text><Text ellipsizeMode="tail" numberOfLines={1} style={[styles.commandDescription, { color: theme.colors.onSurfaceVariant }]}>{props.description}</Text></View><MaterialCommunityIcons color={theme.colors.outline} name="chevron-right" size={19} /></Pressable>;
}

interface ConfigChoiceSheetProps { readonly currentValue?: string; readonly onClose: () => void; readonly onSelect: (id: string) => Promise<void>; readonly options: readonly ConfigOption[]; readonly reduceMotion: boolean; readonly title: string; readonly visible: boolean }
function ConfigChoiceSheet(props: ConfigChoiceSheetProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  return <BottomSheetFrame onClose={props.onClose} panelStyle={styles.choiceSheetMotion} reduceMotion={props.reduceMotion} scrimStyle={styles.modalScrim} visible={props.visible}><GlassPanel blurIntensity={82} glassEffectStyle="regular" materialElevation={5} materialShape="extraLarge" style={styles.choiceSheet}><View style={[styles.sheetHandle, { backgroundColor: theme.colors.outline }]} /><Text variant="headlineSmall" style={styles.sheetTitle}>{props.title}</Text><ScrollView bounces={false} contentContainerStyle={styles.choiceList} showsVerticalScrollIndicator style={styles.boundedScroll}>{props.options.length === 0 ? <Text style={[styles.commandEmpty, { color: theme.colors.onSurfaceVariant }]}>Host 未下发可用选项</Text> : props.options.map((option) => { const selected = option.id === props.currentValue; return <Pressable key={option.id} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => void props.onSelect(option.id)} style={({ pressed }) => [styles.choiceRow, { borderColor: selected ? theme.colors.primary : theme.colors.outlineVariant, backgroundColor: selected ? theme.colors.primaryContainer : theme.colors.surface }, pressed ? styles.pressed : null]}><View style={styles.commandCopy}><Text style={[styles.choiceTitle, { color: theme.colors.onSurface }]}>{option.title}</Text>{option.description === undefined ? null : <Text numberOfLines={2} style={[styles.choiceDescription, { color: theme.colors.onSurfaceVariant }]}>{option.description}</Text>}</View>{selected ? <MaterialCommunityIcons color={theme.colors.primary} name="check" size={21} /> : null}</Pressable>; })}</ScrollView></GlassPanel></BottomSheetFrame>;
}

interface ApprovalSheetProps { readonly approval: PendingApprovalViewModel | undefined; readonly reduceMotion: boolean; readonly onClose: () => void; readonly onDismiss: () => void; readonly onResolve: (decision: 'allow' | 'deny') => Promise<void> }
const ApprovalSheet = memo(function ApprovalSheet(props: ApprovalSheetProps): JSX.Element {
  const theme = useTheme<MD3Theme>(); const [resolving, setResolving] = useState(false); const cachedRef = useRef(props.approval);
  if (props.approval !== undefined) cachedRef.current = props.approval;
  const cached = cachedRef.current;
  if (cached === undefined) return <></>;
  const resolve = async (decision: 'allow' | 'deny'): Promise<void> => { setResolving(true); try { await props.onResolve(decision); } finally { setResolving(false); } };
  return <BottomSheetFrame onClose={props.onClose} onDismiss={props.onDismiss} panelStyle={styles.sheetMotion} reduceMotion={props.reduceMotion} scrimStyle={styles.modalScrim} visible={props.approval !== undefined}><GlassPanel blurIntensity={82} glassEffectStyle="regular" materialElevation={5} materialShape="extraLarge" style={styles.sheet}><View style={[styles.sheetHandle, { backgroundColor: theme.colors.outline }]} /><Text variant="headlineSmall" style={styles.sheetTitle}>权限请求</Text><Text style={[styles.sheetDescription, { color: theme.colors.onSurfaceVariant }]}>允许在 {cached.hostName} 上执行此工具？</Text><View style={[styles.requestIdentity, { backgroundColor: theme.colors.surfaceVariant }]}><MaterialCommunityIcons color={theme.colors.primary} name="wrench-outline" size={22} /><View style={styles.requestCopy}><Text style={styles.requestTool}>{cached.displayName}</Text><Text style={[styles.requestWorkspace, { color: theme.colors.onSurfaceVariant }]}>{cached.workspaceName}</Text></View></View><ScrollView bounces={false} style={[styles.requestInput, { backgroundColor: theme.colors.surfaceVariant }]}><Text selectable style={{ color: theme.colors.onSurfaceVariant }}>{cached.normalizedInput}</Text></ScrollView><View style={styles.sheetActions}><Button disabled={resolving} mode="outlined" onPress={() => void resolve('deny')} style={styles.sheetButton}>拒绝</Button><Button disabled={resolving} icon="check" mode="contained" onPress={() => void resolve('allow')} style={styles.sheetButton}>允许</Button></View></GlassPanel></BottomSheetFrame>;
});

interface InputSheetProps { readonly input: PendingInputViewModel | undefined; readonly reduceMotion: boolean; readonly onClose: () => void; readonly onDismiss: () => void; readonly onResolve: (answers: Readonly<Record<string, string>> | undefined) => Promise<void> }
const InputSheet = memo(function InputSheet(props: InputSheetProps): JSX.Element {
  const theme = useTheme<MD3Theme>(); const [answers, setAnswers] = useState<Readonly<Record<string, readonly string[]>>>({}); const [custom, setCustom] = useState<Readonly<Record<string, string>>>({}); const [resolving, setResolving] = useState(false); const [cached, setCached] = useState(props.input);
  useEffect(() => { if (props.input !== undefined) { setCached(props.input); setAnswers({}); setCustom({}); } }, [props.input]);
  if (cached === undefined) return <></>;
  const toggle = (key: string, label: string, multi: boolean): void => setAnswers((current) => { const previous = current[key] ?? []; return { ...current, [key]: multi ? (previous.includes(label) ? previous.filter((value) => value !== label) : [...previous, label]) : [label] }; });
  const submit = async (): Promise<void> => { setResolving(true); try { await props.onResolve(buildStructuredInputAnswers(cached, answers, custom)); } finally { setResolving(false); } };
  return <BottomSheetFrame onClose={props.onClose} onDismiss={props.onDismiss} panelStyle={styles.sheetMotion} reduceMotion={props.reduceMotion} scrimStyle={styles.modalScrim} visible={props.input !== undefined}><GlassPanel blurIntensity={82} glassEffectStyle="regular" materialElevation={5} materialShape="extraLarge" style={styles.sheet}><View style={[styles.sheetHandle, { backgroundColor: theme.colors.outline }]} /><Text variant="headlineSmall" style={styles.sheetTitle}>需要你的输入</Text><Text style={[styles.sheetDescription, { color: theme.colors.onSurfaceVariant }]}>Cloud 正在等待你回答以下问题</Text><ScrollView bounces={false} contentContainerStyle={styles.questionList} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator style={styles.boundedScroll}>{cached.questions.map((question, index) => <View key={`${cached.id}:question:${index}`} style={styles.questionBlock}><Text variant="labelLarge" style={{ color: theme.colors.primary }}>{question.header}</Text><Text style={styles.questionText}>{question.question}</Text>{question.options.map((option) => { const selected = answers[question.question]?.includes(option.label) === true; return <Pressable key={option.label} accessibilityRole={question.multiSelect ? 'checkbox' : 'radio'} accessibilityState={{ checked: selected }} onPress={() => toggle(question.question, option.label, question.multiSelect)} style={[styles.optionRow, selected ? { borderColor: theme.colors.primary, backgroundColor: theme.colors.primaryContainer } : { borderColor: theme.colors.outlineVariant }]}><MaterialCommunityIcons color={selected ? theme.colors.primary : theme.colors.outline} name={selected ? (question.multiSelect ? 'checkbox-marked' : 'radiobox-marked') : (question.multiSelect ? 'checkbox-blank-outline' : 'radiobox-blank')} size={22} /><View style={styles.optionCopy}><Text style={styles.optionLabel}>{option.label}</Text><Text style={[styles.optionDescription, { color: theme.colors.onSurfaceVariant }]}>{option.description}</Text></View></Pressable>; })}<NativeTextInput accessibilityLabel={`${question.header} 自由输入`} onChangeText={(value) => setCustom((current) => ({ ...current, [question.question]: value }))} placeholder="或输入自定义回答" placeholderTextColor={theme.colors.onSurfaceVariant} style={[styles.customInput, { borderColor: theme.colors.outlineVariant, color: theme.colors.onSurface }]} value={custom[question.question] ?? ''} /></View>)}</ScrollView><View style={styles.sheetActions}><Button disabled={resolving} mode="outlined" onPress={() => void props.onResolve(undefined)} style={styles.sheetButton}>取消</Button><Button disabled={resolving} icon="send" mode="contained" onPress={() => void submit()} style={styles.sheetButton}>提交回答</Button></View></GlassPanel></BottomSheetFrame>;
});

function toolStatusLabel(status: Extract<ChatPartViewModel, { kind: 'tool' }>['status']): string { switch (status) { case 'running': return '运行中'; case 'ready': return '等待执行'; case 'success': return '已完成'; case 'error': return '失败'; } }
function systemMessageLevelLabel(level: Extract<ChatPartViewModel, { kind: 'system' }>['level']): string { switch (level) { case 'progress': return '进行中'; case 'success': return '已完成'; case 'warning': return '注意'; case 'error': return '错误'; case 'info': return '系统'; } }
function systemMessageIcon(level: Extract<ChatPartViewModel, { kind: 'system' }>['level']): ComponentProps<typeof MaterialCommunityIcons>['name'] { switch (level) { case 'progress': return 'progress-clock'; case 'success': return 'check-circle-outline'; case 'warning': return 'alert-outline'; case 'error': return 'alert-circle-outline'; case 'info': return 'information-outline'; } }
function effortDisplayName(effort: ChatViewModel['effort']): string {
  switch (effort) {
    case undefined: return '默认';
    case 'low': return '低';
    case 'medium': return '中';
    case 'high': return '高';
    case 'xhigh': return '极高';
    case 'max': return '最大';
  }
}
const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  topChrome: { left: 0, position: 'absolute', right: 0, top: 0, zIndex: 12 },
  topChromeHeader: { position: 'relative' },
  topChromeMaterial: { ...StyleSheet.absoluteFillObject },
  topChromeContent: { paddingHorizontal: 8, paddingBottom: 2 },
  topChromeEdge: { bottom: 0, height: StyleSheet.hairlineWidth, left: 0, position: 'absolute', right: 0 },
  headerRow: { minHeight: 50, flexDirection: 'row', alignItems: 'center' },
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
  turnBlock: { gap: 13 },
  promptMessage: { alignItems: 'flex-end' },
  promptRow: { alignItems: 'flex-end' },
  promptBubble: { maxWidth: '88%', paddingHorizontal: 14, paddingVertical: 11, borderRadius: 20, borderBottomRightRadius: 6 },
  promptMeasurement: { left: 14, opacity: 0, position: 'absolute', right: 14, top: 11 },
  promptText: { fontSize: 16, lineHeight: 24, fontWeight: '500' },
  messageActions: { flexDirection: 'row', gap: 2, marginTop: 1, minHeight: 48 },
  messageAction: { alignItems: 'center', borderRadius: 12, height: 48, justifyContent: 'center', minWidth: 48 },
  assistantMessageAction: { alignSelf: 'flex-start' },
  failureCard: { marginHorizontal: 8, padding: 13, borderWidth: StyleSheet.hairlineWidth },
  failureContent: { gap: 8 },
  failureHeader: { minHeight: 24, flexDirection: 'row', alignItems: 'center', gap: 8 },
  failureLabel: { fontSize: 15, fontWeight: '700' },
  failureMessage: { fontSize: 14, lineHeight: 21 },
  assistantBlock: { maxWidth: '88%', paddingHorizontal: 8, gap: 9 },
  streamingText: { fontSize: 16, lineHeight: 25 },
  processBlock: { maxWidth: '92%', marginHorizontal: 8 },
  processHeader: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 46, paddingVertical: 7 },
  processTitle: { fontSize: 14, fontWeight: '600' },
  processContent: { borderLeftWidth: 2, gap: 9, paddingBottom: 8, paddingLeft: 14 },
  processWaiting: { fontSize: 13, lineHeight: 20, paddingVertical: 6 },
  processPart: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', padding: 10 },
  processPartHeader: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 28 },
  processPartTitle: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
  processPartStatus: { fontSize: 12 },
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
  boundedProcessScroll: { maxWidth: '100%' },
  emptyTranscript: { flex: 1, minHeight: 220, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyText: { fontSize: 15 },
  composerDock: { position: 'absolute', zIndex: 10, left: 12, right: 12 },
  scrollToBottom: { position: 'absolute', right: 22, zIndex: 11, width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', elevation: 4 },
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
  popoverLayer: { flex: 1, justifyContent: 'flex-end', paddingHorizontal: 18 },
  commandPopoverMotion: { height: '72%', minHeight: 0, width: '100%' },
  commandPopoverContainer: { flex: 1, minHeight: 0 },
  commandPopover: { flex: 1, minHeight: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden', paddingHorizontal: 18, paddingTop: 12, width: '100%' },
  commandScroll: { flex: 1, minHeight: 0 },
  commandList: { padding: 8 },
  commandRow: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 10, minHeight: 62, paddingHorizontal: 10, paddingVertical: 8 },
  commandCopy: { flex: 1, minWidth: 0 },
  commandTitle: { fontSize: 15, fontWeight: '600', lineHeight: 21 },
  commandDescription: { fontSize: 12, lineHeight: 17, marginTop: 1 },
  commandDivider: { height: StyleSheet.hairlineWidth, marginHorizontal: 10, marginVertical: 4 },
  commandLoading: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 56, paddingHorizontal: 12 },
  commandEmpty: { fontSize: 14, lineHeight: 21, padding: 16, textAlign: 'center' },
  sheetBackdrop: { flex: 1, justifyContent: 'flex-end' },
  modalScrim: { backgroundColor: 'rgba(20,26,38,0.22)' },
  sheetMotion: { maxHeight: '88%', width: '100%' },
  choiceSheetMotion: { maxHeight: '72%', width: '100%' },
  sheet: { flexShrink: 1, maxHeight: '100%', minHeight: 0, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 24, borderTopLeftRadius: 28, borderTopRightRadius: 28, gap: 11 },
  choiceSheet: { flexShrink: 1, maxHeight: '100%', minHeight: 0, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 24, borderTopLeftRadius: 28, borderTopRightRadius: 28, gap: 11 },
  boundedScroll: { flexShrink: 1, minHeight: 0 },
  choiceList: { gap: 8, paddingBottom: 4 },
  choiceRow: { alignItems: 'center', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', gap: 12, minHeight: 58, paddingHorizontal: 13, paddingVertical: 10 },
  choiceTitle: { fontSize: 16, fontWeight: '600', lineHeight: 22 },
  choiceDescription: { fontSize: 12, lineHeight: 17, marginTop: 2 },
  sheetHandle: { alignSelf: 'center', width: 42, height: 5, borderRadius: 3, marginBottom: 4 },
  sheetTitle: { fontWeight: '800', marginBottom: 7 },
  sheetDescription: { fontSize: 15, lineHeight: 22 },
  requestIdentity: { minHeight: 58, padding: 11, borderRadius: 11, flexDirection: 'row', alignItems: 'center', gap: 10 },
  requestCopy: { flex: 1, gap: 3 },
  requestTool: { fontSize: 16, fontWeight: '700' },
  requestWorkspace: { fontSize: 13 },
  requestInput: { maxHeight: 160, padding: 12, borderRadius: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 13, lineHeight: 20 },
  sheetActions: { flexDirection: 'row', gap: 10, marginTop: 4 },
  sheetButton: { flex: 1 },
  questionBlock: { gap: 7 },
  questionList: { gap: 14, paddingBottom: 4 },
  questionText: { fontSize: 16, lineHeight: 23, fontWeight: '600' },
  optionRow: { minHeight: 54, paddingHorizontal: 11, paddingVertical: 8, borderWidth: 1, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 9 },
  optionCopy: { flex: 1, gap: 2 },
  optionLabel: { fontSize: 15, fontWeight: '600' },
  optionDescription: { fontSize: 12, lineHeight: 17 },
  customInput: { minHeight: 44, paddingHorizontal: 11, borderWidth: 1, borderRadius: 10, fontSize: 15 },
});

export function parseChatRouteParam(value: string | string[] | undefined): ChatUri | undefined { const candidate = Array.isArray(value) ? value[0] : value; if (candidate === undefined) return undefined; try { return parseChatUri(candidate); } catch { return undefined; } }
