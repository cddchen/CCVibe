import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { memo, useCallback, useState, type ComponentProps, type JSX, type ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type ListRenderItemInfo,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Menu, Text, useTheme, type MD3Theme } from 'react-native-paper';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { GlassSurface } from '../../ui/glass/GlassSurface';
import { useCloudActions, useCloudSelector } from '../runtime/CloudRuntimeProvider';
import { selectHomeView, type CloudRuntimeActions, type PendingSend } from '../runtime/runtimeStore';
import type { HomeModelItem, HomeSessionGroup, HomeSessionItem, HomeViewModel } from './homeSelectors';

const PRESS_SCALE = 0.97;
const PRESS_DURATION = 120;
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function HomeScreen(): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme<MD3Theme>();
  const view = useCloudSelector(selectHomeView);
  const pendingSend = useCloudSelector((state) => state.pendingSend);
  const selectedEffort = useCloudSelector((state) => state.selection.effort);
  const actions = useCloudActions();

  const openConnection = useCallback(() => router.push('/connection'), [router]);
  const openChat = useCallback((chatUri: HomeSessionItem['chatUri']) => {
    router.push({ pathname: '/chat/[chatId]', params: { chatId: chatUri } });
  }, [router]);
  const renderGroup = useCallback(({ item }: ListRenderItemInfo<HomeSessionGroup>) => (
    <SessionGroup group={item} onOpenChat={openChat} />
  ), [openChat]);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex}>
        <FlatList
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: Math.max(insets.bottom + 16, 28) },
            view.groups.length === 0 ? styles.emptyListContent : null,
          ]}
          data={view.groups}
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.workspaceId}
          ListEmptyComponent={<SessionEmpty mode={view.mode} onOpenConnection={openConnection} />}
          ListHeaderComponent={(
            <HomeHeader
              actions={actions}
              onOpenChat={openChat}
              onOpenConnection={openConnection}
              pendingSend={pendingSend}
              selectedEffort={selectedEffort}
              view={view}
            />
          )}
          renderItem={renderGroup}
          showsVerticalScrollIndicator={false}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

interface HomeHeaderProps {
  readonly actions: CloudRuntimeActions;
  readonly onOpenChat: (chatUri: HomeSessionItem['chatUri']) => void;
  readonly onOpenConnection: () => void;
  readonly pendingSend: PendingSend | undefined;
  readonly selectedEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly view: HomeViewModel;
}

const HomeHeader = memo(function HomeHeader(props: HomeHeaderProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [promptError, setPromptError] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const submit = async (): Promise<void> => {
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) {
      setPromptError('请输入消息');
      return;
    }
    if (props.view.selectedWorkspaceId === undefined || props.view.selectedModelId === undefined) return;

    setPromptError(undefined);
    setSending(true);
    try {
      const result = await props.actions.createChatAndSend({
        prompt: trimmedPrompt,
        workspaceId: props.view.selectedWorkspaceId,
        modelId: props.view.selectedModelId,
        effort: props.selectedEffort,
      });
      if (result.status === 'accepted') {
        setPrompt('');
        props.onOpenChat(result.chatUri);
      }
    } finally {
      setSending(false);
    }
  };

  const retry = async (): Promise<void> => {
    setRetrying(true);
    try {
      const result = await props.actions.retryPendingSend();
      if (result.status === 'accepted') props.onOpenChat(result.chatUri);
    } finally {
      setRetrying(false);
    }
  };

  const canCompose = props.view.mode === 'ready' && !sending;
  const selectedWorkspace = props.view.workspaces.find((workspace) => workspace.id === props.view.selectedWorkspaceId);
  const workspaceLabel = compactWorkspacePath(selectedWorkspace?.path ?? props.view.selectedWorkspaceName ?? '选择工作区');
  const modelLabel = props.view.selectedModelName ?? '选择模型';
  const sendDisabled = !canCompose
    || prompt.trim().length === 0
    || props.view.selectedWorkspaceId === undefined
    || props.view.selectedModelId === undefined;

  return (
    <View style={styles.headerContent}>
      <View style={styles.topBar}>
        <GlassSurface
          glassEffectStyle="regular"
          interactive
          materialElevation={1}
          materialShape="full"
          materialTone="surfaceContainerLow"
          style={styles.settingsSurface}
        >
          <GlassPressable accessibilityLabel="打开设置" onPress={props.onOpenConnection} style={styles.settingsButton}>
            <MaterialCommunityIcons color={theme.colors.onSurface} name="cog-outline" size={24} />
          </GlassPressable>
        </GlassSurface>
      </View>

      <View style={styles.hero}>
        <View style={styles.heroCopy}>
          <Text adjustsFontSizeToFit allowFontScaling numberOfLines={1} style={[styles.heroEyebrow, { color: theme.colors.onSurfaceVariant }]}>
            {props.view.hostName ?? 'Cloud Host'}
          </Text>
          <Text adjustsFontSizeToFit allowFontScaling maxFontSizeMultiplier={1.35} numberOfLines={1} style={[styles.brand, { color: theme.colors.onBackground }]}>
            Cloud
          </Text>
          <View style={styles.hostPill}>
            <View style={[styles.statusDot, { backgroundColor: statusColor(props.view.hostStatus, theme) }]} />
            <Text allowFontScaling style={[styles.hostStatusLabel, { color: theme.colors.onSurfaceVariant }]}>
              Host {props.view.hostStatusLabel}
            </Text>
          </View>
        </View>
      </View>

      {props.view.mode === 'loading' ? <StateBanner icon="cloud-sync-outline" text="正在读取 Host 数据" tone="neutral" /> : null}
      {props.view.mode === 'disconnected' ? (
        <StateBanner actionLabel="连接 Host" icon="wifi-off" onAction={props.onOpenConnection} text="尚未连接 Host，连接后可创建对话" tone="warning" />
      ) : null}
      {props.view.mode === 'no-workspace' ? <StateBanner icon="folder-alert-outline" text="Host 没有可用工作目录" tone="warning" /> : null}
      {props.view.mode === 'no-model' ? <StateBanner icon="cube-outline" text="Host 没有可用模型" tone="warning" /> : null}
      {props.view.mode === 'error' ? (
        <StateBanner actionLabel="重新连接" icon="alert-circle-outline" onAction={props.onOpenConnection} text="读取 Host 数据失败" tone="error" />
      ) : null}

      {props.view.operationError !== undefined ? (
        <GlassSurface
          dynamicScheme={{ surfaceContainerHigh: theme.colors.errorContainer }}
          materialElevation={1}
          materialShape="medium"
          materialTone="surfaceContainerHigh"
          solidColor={theme.colors.errorContainer}
          style={styles.operationError}
        >
          <MaterialCommunityIcons color={theme.colors.onErrorContainer} name="alert-outline" size={22} />
          <Text style={[styles.operationErrorText, { color: theme.colors.onErrorContainer }]}>
            {operationErrorLabel(props.view.operationError.code, props.view.operationError.operation)}
          </Text>
          {props.pendingSend !== undefined ? (
            <GlassPressable accessibilityLabel="重试发送" disabled={retrying} onPress={() => void retry()} style={styles.retryButton}>
              {retrying ? <ActivityIndicator color={theme.colors.onErrorContainer} size="small" /> : <Text style={{ color: theme.colors.onErrorContainer }}>重试</Text>}
            </GlassPressable>
          ) : null}
        </GlassSurface>
      ) : null}

      <GlassSurface
        blurIntensity={64}
        glassEffectStyle="regular"
        materialElevation={2}
        materialShape="extraLarge"
        materialTone="surfaceContainer"
        style={styles.composerSurface}
        testID="home-composer-card"
      >
        <TextInput
          accessibilityLabel="新会话输入"
          allowFontScaling
          autoCorrect
          editable={canCompose}
          multiline
          onChangeText={(value) => {
            setPrompt(value);
            if (promptError !== undefined) setPromptError(undefined);
          }}
          onSubmitEditing={() => void submit()}
          placeholder="想让 Cloud 做什么？"
          placeholderTextColor={theme.colors.onSurfaceVariant}
          returnKeyType="send"
          selectionColor={theme.colors.primary}
          style={[styles.composerInput, { color: theme.colors.onSurface }]}
          testID="home-composer"
          textAlignVertical="top"
          value={prompt}
        />
        {promptError !== undefined ? <Text style={[styles.promptError, { color: theme.colors.error }]}>{promptError}</Text> : null}

        <View style={styles.composerToolbar}>
          <View style={styles.workspaceMenuAnchor}>
            <Menu
              visible={directoryOpen}
              onDismiss={() => setDirectoryOpen(false)}
              anchor={(
                <GlassPressable
                  accessibilityLabel="选择工作区目录"
                  disabled={props.view.workspaces.length === 0 || !canCompose}
                  onPress={() => setDirectoryOpen(true)}
                  style={styles.workspaceButton}
                >
                  <MaterialCommunityIcons color={theme.colors.onSurface} name="folder-outline" size={21} />
                  <Text ellipsizeMode="middle" numberOfLines={1} style={[styles.workspaceLabel, { color: theme.colors.onSurfaceVariant }]}>{workspaceLabel}</Text>
                  <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="chevron-down" size={18} />
                </GlassPressable>
              )}
              anchorPosition="top"
              contentStyle={styles.menuContent}
            >
              {props.view.workspaces.length === 0 ? (
                <Menu.Item disabled onPress={() => undefined} title="暂无工作目录" />
              ) : props.view.workspaces.map((workspace) => (
                <Menu.Item
                  key={workspace.id}
                  disabled={!workspace.available}
                  leadingIcon={() => <MaterialCommunityIcons name={workspace.available ? 'folder-outline' : 'folder-remove-outline'} size={21} />}
                  onPress={() => {
                    if (workspace.available) props.actions.setWorkspace(workspace.id);
                    setDirectoryOpen(false);
                  }}
                  title={workspace.path || workspace.name}
                />
              ))}
            </Menu>
          </View>

          <View style={styles.modelMenuAnchor}>
            <Menu
              visible={modelOpen}
              onDismiss={() => setModelOpen(false)}
              anchor={(
                <GlassPressable
                  accessibilityLabel="选择模型"
                  disabled={props.view.models.length === 0 || !canCompose}
                  onPress={() => setModelOpen(true)}
                  style={styles.modelButton}
                >
                  <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.toolbarLabel, { color: theme.colors.onSurfaceVariant }]}>{modelLabel}</Text>
                  <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="chevron-down" size={17} />
                </GlassPressable>
              )}
              anchorPosition="top"
              contentStyle={styles.menuContent}
            >
              {props.view.models.length === 0 ? (
                <Menu.Item disabled onPress={() => undefined} title="暂无模型" />
              ) : props.view.models.map((model) => (
                <ModelMenuItem key={model.id} model={model} onSelect={() => { props.actions.setModel(model.id); setModelOpen(false); }} />
              ))}
            </Menu>
          </View>

          <Menu
            visible={effortOpen}
            onDismiss={() => setEffortOpen(false)}
            anchor={(
              <GlassPressable
                accessibilityLabel="选择思考强度"
                disabled={!canCompose}
                onPress={() => setEffortOpen(true)}
                style={styles.thinkingButton}
              >
                <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.toolbarLabel, { color: theme.colors.onSurfaceVariant }]}>{effortLabel(props.selectedEffort)}</Text>
                <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="chevron-down" size={17} />
              </GlassPressable>
            )}
            anchorPosition="top"
            contentStyle={styles.menuContent}
          >
            {(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((effort) => (
              <Menu.Item
                key={effort}
                onPress={() => { props.actions.setEffort(effort); setEffortOpen(false); }}
                title={effortLabel(effort)}
              />
            ))}
          </Menu>
          <View style={styles.toolbarSpacer} />
          <GlassPressable
            accessibilityLabel="发送消息"
            disabled={sendDisabled}
            onPress={() => void submit()}
            style={[styles.sendButton, { backgroundColor: sendDisabled ? theme.colors.outlineVariant : theme.colors.primary }]}
          >
            {sending ? <ActivityIndicator color={theme.colors.onPrimary} size="small" /> : <MaterialCommunityIcons color={sendDisabled ? theme.colors.onSurfaceVariant : theme.colors.onPrimary} name="arrow-up" size={23} />}
          </GlassPressable>
        </View>
      </GlassSurface>

      <View style={styles.sectionHeading}>
        <Text allowFontScaling style={[styles.sectionTitle, { color: theme.colors.onBackground }]}>最近会话</Text>
      </View>
    </View>
  );
});

interface GlassPressableProps {
  readonly accessibilityHint?: string;
  readonly accessibilityLabel: string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

function GlassPressable(props: GlassPressableProps): JSX.Element {
  const reduceMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ opacity: props.disabled ? 0.48 : 1, transform: [{ scale: scale.get() }] }), [props.disabled]);
  const pressIn = (): void => { scale.set(withTiming(reduceMotion ? 1 : PRESS_SCALE, { duration: reduceMotion ? 0 : PRESS_DURATION })); };
  const pressOut = (): void => { scale.set(withTiming(1, { duration: reduceMotion ? 0 : PRESS_DURATION })); };

  return (
    <AnimatedPressable
      accessibilityHint={props.accessibilityHint}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
      onPressIn={pressIn}
      onPressOut={pressOut}
      pressRetentionOffset={12}
      style={[props.style, animatedStyle]}
    >
      {props.children}
    </AnimatedPressable>
  );
}

interface ModelMenuItemProps { readonly model: HomeModelItem; readonly onSelect: () => void; }

const ModelMenuItem = memo(function ModelMenuItem(props: ModelMenuItemProps): JSX.Element {
  return <Menu.Item leadingIcon={() => <MaterialCommunityIcons name="cube-outline" size={21} />} onPress={props.onSelect} title={props.model.displayName} />;
});

interface SessionGroupProps {
  readonly group: HomeSessionGroup;
  readonly onOpenChat: (chatUri: HomeSessionItem['chatUri']) => void;
}

const SessionGroup = memo(function SessionGroup(props: SessionGroupProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  return (
    <View style={styles.groupBlock}>
      <View style={styles.groupHeading}>
        <Text allowFontScaling ellipsizeMode="tail" numberOfLines={1} style={[styles.groupName, { color: theme.colors.onSurfaceVariant }]}>{props.group.workspaceName}</Text>
        <Text style={[styles.groupCount, { color: theme.colors.onSurfaceVariant }]}>{props.group.sessions.length}</Text>
      </View>
      <GlassSurface materialElevation={1} materialShape="large" materialTone="surfaceContainerLow" style={styles.groupSurface}>
        {props.group.sessions.map((session, index) => (
          <View key={session.id}>
            {index > 0 ? <View style={[styles.sessionDivider, { backgroundColor: theme.colors.outlineVariant }]} /> : null}
            <GlassPressable accessibilityLabel={`打开会话 ${session.title}`} onPress={() => props.onOpenChat(session.chatUri)} style={styles.sessionRow}>
              <View style={[styles.sessionStatus, { backgroundColor: sessionStatusColor(session.status, theme) }]} />
              <View style={styles.sessionCopy}>
                <Text allowFontScaling ellipsizeMode="tail" numberOfLines={1} style={[styles.sessionTitle, { color: theme.colors.onSurface }]}>{session.title}</Text>
                <Text allowFontScaling ellipsizeMode="tail" numberOfLines={1} style={[styles.sessionMeta, { color: theme.colors.onSurfaceVariant }]}>{sessionStatusLabel(session.status)}</Text>
              </View>
              <Text style={[styles.sessionTime, { color: theme.colors.onSurfaceVariant }]}>{formatSessionDate(session.updatedAt)}</Text>
              <MaterialCommunityIcons color={theme.colors.outline} name="chevron-right" size={22} />
            </GlassPressable>
          </View>
        ))}
      </GlassSurface>
    </View>
  );
});

interface SessionEmptyProps { readonly mode: HomeViewModel['mode']; readonly onOpenConnection: () => void; }

function SessionEmpty(props: SessionEmptyProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const emptyCopy = props.mode === 'ready' ? '暂无会话' : props.mode === 'loading' ? '正在加载会话' : props.mode === 'disconnected' ? '连接 Host 后显示会话' : '暂无可显示的会话';
  return (
    <GlassSurface materialElevation={0} materialShape="large" materialTone="surfaceContainerLow" style={styles.emptySurface}>
      {props.mode === 'loading' ? <ActivityIndicator /> : <MaterialCommunityIcons color={theme.colors.outline} name="message-text-outline" size={30} />}
      <Text allowFontScaling style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>{emptyCopy}</Text>
      {props.mode === 'disconnected' ? (
        <GlassPressable accessibilityLabel="连接 Host" onPress={props.onOpenConnection} style={styles.emptyAction}>
          <Text style={{ color: theme.colors.primary }}>连接 Host</Text>
        </GlassPressable>
      ) : null}
    </GlassSurface>
  );
}

interface StateBannerProps {
  readonly actionLabel?: string;
  readonly icon: ComponentProps<typeof MaterialCommunityIcons>['name'];
  readonly onAction?: () => void;
  readonly text: string;
  readonly tone: 'neutral' | 'warning' | 'error';
}

function StateBanner(props: StateBannerProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const backgroundColor = props.tone === 'error' ? theme.colors.errorContainer : props.tone === 'warning' ? theme.colors.tertiaryContainer : theme.colors.surfaceVariant;
  const foregroundColor = props.tone === 'error' ? theme.colors.onErrorContainer : props.tone === 'warning' ? theme.colors.onTertiaryContainer : theme.colors.onSurfaceVariant;
  return (
    <GlassSurface dynamicScheme={{ surfaceContainerHigh: backgroundColor }} materialElevation={0} materialShape="medium" materialTone="surfaceContainerHigh" solidColor={backgroundColor} style={styles.stateBanner}>
      <MaterialCommunityIcons color={foregroundColor} name={props.icon} size={22} />
      <Text allowFontScaling style={[styles.stateBannerText, { color: foregroundColor }]}>{props.text}</Text>
      {props.actionLabel !== undefined && props.onAction !== undefined ? (
        <GlassPressable accessibilityLabel={props.actionLabel} onPress={props.onAction} style={styles.bannerAction}>
          <Text style={{ color: foregroundColor }}>{props.actionLabel}</Text>
        </GlassPressable>
      ) : null}
    </GlassSurface>
  );
}

function statusColor(status: HomeViewModel['hostStatus'], theme: MD3Theme): string {
  switch (status) {
    case 'online': return theme.colors.primary;
    case 'degraded': return theme.colors.tertiary;
    case 'connecting': return theme.colors.secondary;
    case 'offline': return theme.colors.outline;
  }
}

function sessionStatusColor(status: HomeSessionItem['status'], theme: MD3Theme): string {
  switch (status) {
    case 'running': return theme.colors.primary;
    case 'waiting': return theme.colors.tertiary;
    case 'error': return theme.colors.error;
    case 'idle': return theme.colors.onSurfaceVariant;
  }
}

function sessionStatusLabel(status: HomeSessionItem['status']): string {
  switch (status) {
    case 'running': return '进行中';
    case 'waiting': return '等待输入';
    case 'error': return '需要重试';
    case 'idle': return '已完成';
  }
}

function formatSessionDate(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const elapsed = now.getTime() - date.getTime();
  if (elapsed >= 0 && elapsed < 60 * 60 * 1000) return '刚刚';
  if (elapsed >= 0 && elapsed < 24 * 60 * 60 * 1000) return `${Math.max(1, Math.floor(elapsed / (60 * 60 * 1000)))}小时前`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function compactWorkspacePath(path: string): string {
  if (path.length <= 24) return path;
  const normalized = path.replace(/\/+$/, '');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return name.length > 0 ? `…/${name}` : path;
}

function effortLabel(effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'): string {
  switch (effort) {
    case 'low': return '低';
    case 'medium': return '中';
    case 'high': return '高';
    case 'xhigh': return '极高';
    case 'max': return '最大';
  }
}

function operationErrorLabel(code: string, operation: 'create' | 'subscribe' | 'send' | undefined): string {
  if (operation === 'send') {
    switch (code) {
      case 'CHAT_BUSY': return '消息暂未发送，当前对话仍可重试';
      case 'TIMEOUT': return '发送超时，当前对话仍可重试';
      default: return '消息发送失败，当前对话仍可重试';
    }
  }
  if (operation === 'subscribe') return '对话已创建，但订阅失败，可重试发送';
  if (code === 'NOT_CONNECTED') return '尚未连接 Host';
  return '创建对话失败，请检查 Host 状态';
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  listContent: { paddingHorizontal: 20, paddingTop: 4, gap: 14 },
  emptyListContent: { flexGrow: 1 },
  headerContent: { gap: 14 },
  topBar: { alignItems: 'flex-end', justifyContent: 'center', minHeight: 54 },
  settingsSurface: { borderRadius: 22, height: 44, overflow: 'hidden', width: 44 },
  settingsButton: { alignItems: 'center', height: 44, justifyContent: 'center', width: 44 },
  hero: { alignItems: 'center', justifyContent: 'center', minHeight: 334, paddingBottom: 8 },
  heroCopy: { alignItems: 'center', justifyContent: 'center' },
  heroEyebrow: { fontSize: 15, letterSpacing: 0.2, marginBottom: 8 },
  brand: { fontSize: 56, fontWeight: '800', letterSpacing: -2.4, lineHeight: 64 },
  hostPill: { alignItems: 'center', flexDirection: 'row', gap: 9, marginTop: 10, minHeight: 28 },
  statusDot: { borderRadius: 6, height: 11, width: 11 },
  hostStatusLabel: { fontSize: 17, letterSpacing: 0.1 },
  stateBanner: { alignItems: 'center', borderRadius: 16, flexDirection: 'row', gap: 9, minHeight: 56, paddingHorizontal: 14, paddingVertical: 8 },
  stateBannerText: { flex: 1, lineHeight: 21 },
  bannerAction: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingHorizontal: 8 },
  operationError: { alignItems: 'center', borderRadius: 16, flexDirection: 'row', gap: 8, minHeight: 56, paddingHorizontal: 14, paddingVertical: 7 },
  operationErrorText: { flex: 1, lineHeight: 21 },
  retryButton: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 48, paddingHorizontal: 6 },
  composerSurface: { borderColor: 'rgba(255,255,255,0.78)', borderRadius: 28, borderWidth: StyleSheet.hairlineWidth, minHeight: 208, paddingHorizontal: 14, paddingTop: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 14 }, shadowOpacity: 0.08, shadowRadius: 28 },
  composerInput: { fontSize: 20, lineHeight: 29, minHeight: 143, paddingBottom: 8, paddingHorizontal: 10, paddingTop: 8 },
  promptError: { paddingBottom: 2, paddingHorizontal: 10 },
  composerToolbar: { alignItems: 'center', flexDirection: 'row', gap: 2, minHeight: 54, paddingBottom: 2 },
  workspaceMenuAnchor: { flex: 1, minWidth: 44 },
  workspaceButton: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 6, justifyContent: 'flex-start', minHeight: 44, overflow: 'hidden', paddingHorizontal: 5, width: '100%' },
  workspaceLabel: { flexShrink: 1, fontSize: 13, minWidth: 0 },
  modelMenuAnchor: { maxWidth: 90, minWidth: 62, width: 90 },
  modelButton: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', gap: 2, justifyContent: 'center', minHeight: 44, paddingHorizontal: 4, width: '100%' },
  thinkingButton: { alignItems: 'center', borderRadius: 14, flexDirection: 'row', justifyContent: 'center', maxWidth: 70, minHeight: 44, minWidth: 56, paddingHorizontal: 4 },
  toolbarLabel: { flexShrink: 1, fontSize: 13 },
  toolbarSpacer: { flex: 0.2, minWidth: 1 },
  sendButton: { alignItems: 'center', borderRadius: 24, height: 48, justifyContent: 'center', minWidth: 48, padding: 0, width: 48 },
  menuContent: { maxHeight: 360 },
  sectionHeading: { alignItems: 'center', minHeight: 52, paddingHorizontal: 2, paddingTop: 8 },
  sectionTitle: { fontSize: 28, fontWeight: '800', letterSpacing: -0.6, lineHeight: 36, width: '100%' },
  groupBlock: { gap: 8 },
  groupHeading: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 28, paddingHorizontal: 4 },
  groupName: { flex: 1, fontSize: 15, fontWeight: '600' },
  groupCount: { fontSize: 13, marginLeft: 8 },
  groupSurface: { borderRadius: 20, overflow: 'hidden' },
  sessionDivider: { height: StyleSheet.hairlineWidth, marginLeft: 26 },
  sessionRow: { alignItems: 'center', flexDirection: 'row', gap: 10, minHeight: 76, paddingHorizontal: 16 },
  sessionStatus: { borderRadius: 5, height: 9, width: 9 },
  sessionCopy: { flex: 1, minWidth: 0 },
  sessionTitle: { fontSize: 16, fontWeight: '600', lineHeight: 23 },
  sessionMeta: { fontSize: 13, lineHeight: 20, marginTop: 1 },
  sessionTime: { fontSize: 12, marginLeft: 2 },
  emptySurface: { alignItems: 'center', borderRadius: 20, gap: 10, justifyContent: 'center', minHeight: 152, padding: 18 },
  emptyText: { textAlign: 'center' },
  emptyAction: { alignItems: 'center', borderRadius: 14, justifyContent: 'center', minHeight: 44, paddingHorizontal: 10 },
});
