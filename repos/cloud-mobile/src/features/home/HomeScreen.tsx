import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { memo, useCallback, useState, type ComponentProps, type JSX } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Divider,
  FAB,
  IconButton,
  Menu,
  Text,
  TextInput,
  useTheme,
  type MD3Theme,
} from 'react-native-paper';

import { GlassSurface } from '../../ui/glass/GlassSurface';
import {
  useCloudActions,
  useCloudSelector,
} from '../runtime/CloudRuntimeProvider';
import { selectHomeView, type CloudRuntimeActions, type PendingSend } from '../runtime/runtimeStore';
import type {
  HomeModelItem,
  HomeSessionGroup,
  HomeSessionItem,
  HomeViewModel,
} from './homeSelectors';

export default function HomeScreen(): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme<MD3Theme>();
  const view = useCloudSelector(selectHomeView);
  const pendingSend = useCloudSelector((state) => state.pendingSend);
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
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <FlatList
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: Math.max(insets.bottom, 24) },
            view.groups.length === 0 ? styles.emptyListContent : null,
          ]}
          data={view.groups}
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.workspaceId}
          ListEmptyComponent={<SessionEmpty mode={view.mode} onOpenConnection={openConnection} />}
          ListHeaderComponent={(
            <HomeHeader
              actions={actions}
              onOpenChat={openChat}
              onOpenConnection={openConnection}
              pendingSend={pendingSend}
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
  readonly view: HomeViewModel;
}

const HomeHeader = memo(function HomeHeader(props: HomeHeaderProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
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
  const modelLabel = props.view.selectedModelName ?? '选择模型';

  return (
    <View style={styles.headerContent}>
      <View style={styles.topBar}>
        <View style={styles.topBarPlaceholder} />
        <Text adjustsFontSizeToFit maxFontSizeMultiplier={1.2} minimumFontScale={0.86} numberOfLines={1} style={[styles.brand, { color: theme.colors.onBackground }]}>Cloud</Text>
        <GlassSurface materialElevation={1} materialShape="medium" materialTone="surfaceContainerLow" style={styles.newChatSurface}>
          <Pressable
            accessibilityLabel="新对话"
            accessibilityRole="button"
            onPress={() => {
              setPrompt('');
              setPromptError(undefined);
              props.actions.clearOperationError();
            }}
            style={styles.newChatButton}
          >
            <MaterialCommunityIcons color={theme.colors.primary} name="plus-circle-outline" size={22} />
            <Text style={[styles.newChatLabel, { color: theme.colors.primary }]}>新对话</Text>
          </Pressable>
        </GlassSurface>
      </View>

      <Menu
        visible={directoryOpen}
        onDismiss={() => setDirectoryOpen(false)}
        anchor={(
          <GlassSurface
            materialElevation={1}
            materialShape="large"
            materialTone="surfaceContainerLow"
            style={styles.selectorSurface}
          >
            <Pressable
              accessibilityLabel="选择目录"
              accessibilityRole="button"
              disabled={props.view.workspaces.length === 0}
              onPress={() => setDirectoryOpen(true)}
              style={styles.selectorRow}
            >
              <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="folder-outline" size={25} />
              <View style={styles.selectorCopy}>
                <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>工作目录</Text>
                <Text ellipsizeMode="tail" numberOfLines={1} style={styles.selectorValue}>
                  {props.view.selectedWorkspaceName ?? '暂无工作目录'}
                </Text>
              </View>
              <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="chevron-down" size={25} />
            </Pressable>
          </GlassSurface>
        )}
        anchorPosition="bottom"
        contentStyle={styles.menuContent}
      >
        {props.view.workspaces.length === 0 ? (
          <Menu.Item disabled onPress={() => undefined} title="暂无工作目录" />
        ) : props.view.workspaces.map((workspace) => (
          <Menu.Item
            key={workspace.id}
            disabled={!workspace.available}
            leadingIcon={() => (
              <MaterialCommunityIcons
                name={workspace.available ? 'folder-outline' : 'folder-remove-outline'}
                size={22}
              />
            )}
            onPress={() => {
              if (workspace.available) props.actions.setWorkspace(workspace.id);
              setDirectoryOpen(false);
            }}
            title={workspace.name}
          />
        ))}
      </Menu>

      <GlassSurface
        materialElevation={1}
        materialShape="large"
        materialTone="surfaceContainerLow"
        style={styles.hostSurface}
      >
        <Pressable
          accessibilityLabel="Host 连接状态"
          accessibilityRole="button"
          onPress={props.onOpenConnection}
          style={styles.hostRow}
        >
          <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="server-network-outline" size={25} />
          <View style={styles.hostCopy}>
            <Text ellipsizeMode="tail" numberOfLines={1} style={styles.hostName}>{props.view.hostName ?? 'Host'}</Text>
            <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {props.view.hostStatusLabel}
            </Text>
          </View>
          <View style={[styles.statusDot, { backgroundColor: statusColor(props.view.hostStatus, theme) }]} />
          <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="chevron-right" size={24} />
        </Pressable>
      </GlassSurface>

      {props.view.mode === 'loading' ? (
        <StateBanner icon="cloud-sync-outline" text="正在读取 Host 数据" tone="neutral" />
      ) : null}
      {props.view.mode === 'disconnected' ? (
        <StateBanner
          actionLabel="连接 Host"
          icon="wifi-off"
          onAction={props.onOpenConnection}
          text="尚未连接 Host，连接后可创建对话"
          tone="warning"
        />
      ) : null}
      {props.view.mode === 'no-workspace' ? (
        <StateBanner icon="folder-alert-outline" text="Host 没有可用工作目录" tone="warning" />
      ) : null}
      {props.view.mode === 'no-model' ? (
        <StateBanner icon="cube-outline" text="Host 没有可用模型" tone="warning" />
      ) : null}
      {props.view.mode === 'error' ? (
        <StateBanner
          actionLabel="重新连接"
          icon="alert-circle-outline"
          onAction={props.onOpenConnection}
          text="读取 Host 数据失败"
          tone="error"
        />
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
            <Button
              compact
              contentStyle={styles.retryContent}
              icon={({ color, size }) => <MaterialCommunityIcons color={color} name="refresh" size={size} />}
              loading={retrying}
              onPress={() => void retry()}
              textColor={theme.colors.onErrorContainer}
            >
              重试
            </Button>
          ) : null}
        </GlassSurface>
      ) : null}

      <GlassSurface
        materialElevation={2}
        materialShape="large"
        materialTone="surfaceContainer"
        style={styles.composerSurface}
      >
        <TextInput
          accessibilityLabel="消息输入框"
          disabled={!canCompose}
          error={promptError !== undefined}
          multiline
          numberOfLines={5}
          onChangeText={(value) => {
            setPrompt(value);
            if (promptError !== undefined) setPromptError(undefined);
          }}
          onSubmitEditing={() => void submit()}
          placeholder="描述你想完成的任务…"
          mode="outlined"
          outlineStyle={styles.composerInputOutline}
          contentStyle={styles.composerInputContent}
          value={prompt}
          testID="home-composer"
        />
        {promptError !== undefined ? <Text style={[styles.promptError, { color: theme.colors.error }]}>{promptError}</Text> : null}
        <View style={styles.composerToolbar}>
          <IconButton
            accessibilityLabel="添加附件"
            disabled={!canCompose}
            icon={({ color, size }) => <MaterialCommunityIcons color={color} name="plus" size={size} />}
            mode="contained-tonal"
            onPress={() => undefined}
            size={24}
          />
          <Menu
            visible={modelOpen}
            onDismiss={() => setModelOpen(false)}
            anchor={(
              <View style={styles.modelMenuAnchor}>
                <Pressable
                  accessibilityLabel="选择模型"
                  accessibilityRole="button"
                  disabled={props.view.models.length === 0 || !canCompose}
                  onPress={() => setModelOpen(true)}
                  style={[styles.modelButton, { backgroundColor: theme.colors.surfaceVariant }]}
                >
                  <Text ellipsizeMode="tail" numberOfLines={1} style={[styles.modelLabel, { color: theme.colors.onSurface }]}>{modelLabel}</Text>
                  <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="chevron-down" size={20} />
                </Pressable>
              </View>
            )}
            anchorPosition="top"
            contentStyle={styles.menuContent}
          >
            {props.view.models.length === 0 ? (
              <Menu.Item disabled onPress={() => undefined} title="暂无模型" />
            ) : props.view.models.map((model) => (
              <ModelMenuItem
                key={model.id}
                model={model}
                onSelect={() => {
                  props.actions.setModel(model.id);
                  setModelOpen(false);
                }}
              />
            ))}
          </Menu>
          <View style={styles.toolbarSpacer} />
          <IconButton
            accessibilityLabel="语音输入"
            disabled
            icon={({ color, size }) => <MaterialCommunityIcons color={color} name="microphone-outline" size={size} />}
            size={24}
          />
          <FAB
            accessibilityLabel="发送消息"
            color={theme.colors.onPrimary}
            customSize={52}
            disabled={!canCompose || props.view.selectedWorkspaceId === undefined || props.view.selectedModelId === undefined}
            icon={({ color, size }) => <MaterialCommunityIcons color={color} name="arrow-up" size={size} />}
            loading={sending}
            onPress={() => void submit()}
            style={[styles.sendButton, { backgroundColor: theme.colors.primary }]}
          />
        </View>
      </GlassSurface>

      <View style={styles.sectionHeading}>
        <Text variant="headlineSmall" style={styles.sectionTitle}>会话</Text>
        <IconButton
          accessibilityLabel="会话排序"
          icon={({ color, size }) => <MaterialCommunityIcons color={color} name="sort-variant" size={size} />}
          onPress={() => undefined}
          size={28}
        />
      </View>
    </View>
  );
});

interface ModelMenuItemProps {
  readonly model: HomeModelItem;
  readonly onSelect: () => void;
}

const ModelMenuItem = memo(function ModelMenuItem(props: ModelMenuItemProps): JSX.Element {
  return (
    <Menu.Item
      leadingIcon={() => <MaterialCommunityIcons name="cube-outline" size={22} />}
      onPress={props.onSelect}
      title={props.model.displayName}
    />
  );
});

interface SessionGroupProps {
  readonly group: HomeSessionGroup;
  readonly onOpenChat: (chatUri: HomeSessionItem['chatUri']) => void;
}

const SessionGroup = memo(function SessionGroup(props: SessionGroupProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  return (
    <GlassSurface
      materialElevation={1}
      materialShape="medium"
      materialTone="surfaceContainerLow"
      style={styles.groupSurface}
    >
      <View style={styles.groupHeader}>
        <Text numberOfLines={1} style={styles.groupName}>{props.group.workspaceName}</Text>
        <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
          {props.group.sessions.length}
        </Text>
      </View>
      {props.group.sessions.map((session, index) => (
        <View key={session.id}>
          {index > 0 ? <Divider /> : null}
          <Pressable
            accessibilityLabel={`打开会话 ${session.title}`}
            accessibilityRole="button"
            onPress={() => props.onOpenChat(session.chatUri)}
            style={({ pressed }) => [styles.sessionRow, pressed ? styles.pressed : null]}
          >
            <MaterialCommunityIcons
              color={sessionStatusColor(session.status, theme)}
              name={session.status === 'error' ? 'alert-circle-outline' : 'message-outline'}
              size={24}
            />
            <Text ellipsizeMode="tail" numberOfLines={1} style={styles.sessionTitle}>{session.title}</Text>
            <MaterialCommunityIcons color={theme.colors.outline} name="chevron-right" size={24} />
          </Pressable>
        </View>
      ))}
    </GlassSurface>
  );
});

interface SessionEmptyProps {
  readonly mode: HomeViewModel['mode'];
  readonly onOpenConnection: () => void;
}

function SessionEmpty(props: SessionEmptyProps): JSX.Element {
  const theme = useTheme<MD3Theme>();
  const emptyCopy = props.mode === 'ready'
    ? '暂无会话'
    : props.mode === 'loading'
      ? '正在加载会话'
      : props.mode === 'disconnected'
        ? '连接 Host 后显示会话'
        : '暂无可显示的会话';
  return (
    <GlassSurface materialElevation={0} materialShape="medium" materialTone="surfaceContainerLow" style={styles.emptySurface}>
      {props.mode === 'loading' ? <ActivityIndicator /> : <MaterialCommunityIcons color={theme.colors.outline} name="message-text-outline" size={30} />}
      <Text style={[styles.emptyText, { color: theme.colors.onSurfaceVariant }]}>{emptyCopy}</Text>
      {props.mode === 'disconnected' ? (
        <Button
          compact
          icon={({ color, size }) => <MaterialCommunityIcons color={color} name="connection" size={size} />}
          onPress={props.onOpenConnection}
        >
          连接 Host
        </Button>
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
  const backgroundColor = props.tone === 'error'
    ? theme.colors.errorContainer
    : props.tone === 'warning'
      ? theme.colors.tertiaryContainer
      : theme.colors.surfaceVariant;
  const foregroundColor = props.tone === 'error'
    ? theme.colors.onErrorContainer
    : props.tone === 'warning'
      ? theme.colors.onTertiaryContainer
      : theme.colors.onSurfaceVariant;
  return (
    <GlassSurface
      dynamicScheme={{ surfaceContainerHigh: backgroundColor }}
      materialElevation={0}
      materialShape="medium"
      materialTone="surfaceContainerHigh"
      solidColor={backgroundColor}
      style={styles.stateBanner}
    >
      <MaterialCommunityIcons color={foregroundColor} name={props.icon} size={22} />
      <Text style={[styles.stateBannerText, { color: foregroundColor }]}>{props.text}</Text>
      {props.actionLabel !== undefined && props.onAction !== undefined ? (
        <Button compact contentStyle={styles.retryContent} onPress={props.onAction} textColor={foregroundColor}>
          {props.actionLabel}
        </Button>
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
  listContent: { paddingHorizontal: 18, paddingTop: 8, gap: 12 },
  emptyListContent: { flexGrow: 1 },
  headerContent: { gap: 12 },
  topBar: { minHeight: 64, position: 'relative', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  topBarPlaceholder: { flex: 1 },
  brand: { position: 'absolute', left: 0, right: 0, textAlign: 'center', fontSize: 38, fontWeight: '800' },
  newChatSurface: { flexShrink: 0, minWidth: 112, borderRadius: 14 },
  newChatButton: { minHeight: 48, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  newChatLabel: { fontSize: 15, fontWeight: '700' },
  selectorSurface: { borderRadius: 18 },
  selectorRow: { minHeight: 72, borderRadius: 18, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 12 },
  selectorCopy: { flex: 1, minWidth: 0, gap: 3 },
  selectorValue: { minWidth: 0, flexShrink: 1, fontSize: 18, fontWeight: '600' },
  menuContent: { maxHeight: 360 },
  hostSurface: { borderRadius: 18 },
  hostRow: { minHeight: 72, borderRadius: 18, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 12 },
  hostCopy: { flex: 1, minWidth: 0, gap: 3 },
  hostName: { minWidth: 0, flexShrink: 1, fontSize: 17, fontWeight: '600' },
  statusDot: { width: 11, height: 11, borderRadius: 6 },
  stateBanner: { minHeight: 56, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 9 },
  stateBannerText: { flex: 1, lineHeight: 21 },
  operationError: { minHeight: 56, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 8 },
  operationErrorText: { flex: 1, lineHeight: 21 },
  retryContent: { minHeight: 40 },
  composerSurface: { borderRadius: 22, padding: 12, gap: 5 },
  composerInputOutline: { borderRadius: 18 },
  composerInputContent: { minHeight: 138, paddingTop: 16, paddingBottom: 12, fontSize: 18, lineHeight: 27 },
  promptError: { paddingHorizontal: 10 },
  composerToolbar: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 3 },
  toolbarSpacer: { flex: 1 },
  modelMenuAnchor: { flexGrow: 1, flexShrink: 1, minWidth: 132, maxWidth: 210 },
  modelButton: { width: '100%', minWidth: 0, minHeight: 48, flexShrink: 1, borderRadius: 24, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 },
  modelLabel: { minWidth: 0, flex: 1, flexShrink: 1, fontSize: 15, fontWeight: '600' },
  sendButton: { margin: 0 },
  sectionHeading: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  sectionTitle: { fontWeight: '800' },
  groupSurface: { borderRadius: 14, overflow: 'hidden' },
  groupHeader: { minHeight: 52, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  groupName: { flex: 1, fontSize: 18, fontWeight: '700' },
  sessionRow: { minHeight: 64, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 12 },
  sessionTitle: { flex: 1, fontSize: 17 },
  pressed: { opacity: 0.7 },
  emptySurface: { minHeight: 152, borderRadius: 14, alignItems: 'center', justifyContent: 'center', padding: 18, gap: 10 },
  emptyText: { textAlign: 'center' },
});
