import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, useTheme, type MD3Theme } from 'react-native-paper';

import {
  useCloudActions,
  useCloudSelector,
} from '../runtime/CloudRuntimeProvider';
import { validateConnectionForm, type ConnectionFormValues } from './connectionForm';
import type { CloudRuntimeState } from '../runtime/runtimeStore';
import type { ConnectionId } from '../../protocol/ids';
import type { ConnectionPreferences } from '../../storage/connectionPreferences';
import { GlassSurface } from '../../ui/glass/GlassSurface';
import { CLOUD_DESIGN_TOKENS } from '../../ui/theme/cloudTheme';

const initialForm: ConnectionFormValues = {
  hostUrl: '',
  token: '',
  developmentMode: false,
};

export default function ConnectionScreen(): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme<MD3Theme>();
  const actions = useCloudActions();
  const connection = useCloudSelector(selectConnectionScreenState);
  const [form, setForm] = useState<ConnectionFormValues>(initialForm);
  const [errors, setErrors] = useState<Readonly<Partial<Record<'hostUrl' | 'token', string>>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<ConnectionId | null | undefined>();
  const hasEditedForm = useRef(false);

  useEffect(() => {
    if (connection.selectedHost === undefined) {
      setEditingConnectionId(null);
      if (!hasEditedForm.current) setForm(initialForm);
      return;
    }
    if (hasEditedForm.current) return;
    setForm((current) => ({
      ...current,
      hostUrl: connection.selectedHost?.address ?? '',
      token: '',
      developmentMode: connection.selectedHost?.mode === 'development',
    }));
    setEditingConnectionId(undefined);
  }, [connection.selectedHost]);

  const updateForm = (patch: Partial<ConnectionFormValues>): void => {
    hasEditedForm.current = true;
    setForm((current) => ({ ...current, ...patch }));
    if ('hostUrl' in patch && errors.hostUrl !== undefined) {
      setErrors((current) => ({ ...current, hostUrl: undefined }));
    }
    if ('token' in patch && errors.token !== undefined) {
      setErrors((current) => ({ ...current, token: undefined }));
    }
  };

  const submit = async (): Promise<void> => {
    const validation = validateConnectionForm(form);
    // A blank token while editing an existing row means "keep the protected
    // token". Runtime resolves it from that Host's SecureStore namespace.
    const canKeepStoredToken = editingConnectionId !== null
      && !validation.ok
      && validation.errors.hostUrl === undefined
      && validation.errors.token !== undefined;
    if (!validation.ok && !canKeepStoredToken) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const result = await actions.connect(form, editingConnectionId ?? null);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setEditingConnectionId(undefined);
      hasEditedForm.current = false;
      router.replace('/');
    } finally {
      setSubmitting(false);
    }
  };

  const reconnect = async (): Promise<void> => {
    setSubmitting(true);
    try {
      if (await actions.reconnectSaved()) router.replace('/');
    } finally {
      setSubmitting(false);
    }
  };

  const beginEditing = (): void => {
    hasEditedForm.current = false;
    setErrors({});
    setForm({
      hostUrl: connection.selectedHost?.address ?? '',
      token: '',
      developmentMode: connection.selectedHost?.mode === 'development',
    });
    setEditingConnectionId(connection.selectedHost?.connectionId ?? null);
  };

  const addHost = (): void => {
    hasEditedForm.current = false;
    setErrors({});
    setForm(initialForm);
    setEditingConnectionId(null);
  };

  const switchHost = async (host: ConnectionPreferences): Promise<void> => {
    if (submitting || editingConnectionId !== undefined || host.connectionId === connection.selectedConnectionId) return;
    setErrors({});
    setSubmitting(true);
    try {
      const result = await actions.switchConnection(host.connectionId);
      if (result.ok) {
        router.replace('/');
      } else {
        setErrors(result.errors);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const statusLabel = connectionStatusLabel(connection.syncStatus);
  const statusColor = syncStatusColor(connection.syncStatus, theme);
  const editing = editingConnectionId !== undefined;
  const hasSavedConnection = connection.selectedHost !== undefined;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View pointerEvents="none" style={[styles.ambient, { backgroundColor: theme.colors.primaryContainer }]} />
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 28) }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <Pressable
              accessibilityLabel="返回首页"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => router.back()}
              style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}
              testID="connection-back"
            >
              <MaterialCommunityIcons color={theme.colors.onBackground} name="chevron-left" size={28} />
            </Pressable>
            <Pressable
              accessibilityLabel={editing ? '保存连接设置' : '编辑连接设置'}
              accessibilityRole="button"
              disabled={submitting}
              hitSlop={8}
              onPress={() => {
                if (editing) void submit();
                else beginEditing();
              }}
              style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}
              testID="connection-edit"
            >
              <Text style={[styles.editLabel, { color: theme.colors.primary }]}>{editing ? '保存' : '编辑'}</Text>
            </Pressable>
            <View style={styles.heroMark}>
              <MaterialCommunityIcons color="#FFFFFF" name="cloud-outline" size={39} />
            </View>
            <Text style={[styles.eyebrow, { color: theme.colors.onSurfaceVariant }]}>远程移动控制端</Text>
            <Text style={[styles.heroTitle, { color: theme.colors.onBackground }]}>Cloud</Text>
            <View accessibilityLiveRegion="polite" style={styles.statusPill}>
              <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
              <Text style={[styles.statusText, { color: theme.colors.onSurfaceVariant }]}>Host {statusLabel}</Text>
            </View>
          </View>

          <GlassSurface
            materialElevation={1}
            materialShape="extraLarge"
            materialTone="surfaceContainer"
            solidColor={theme.colors.surface}
            style={styles.connectionCard}
            testID="connection-settings-card"
          >
            <View style={styles.cardHeader}>
              <View>
                <Text style={[styles.cardTitle, { color: theme.colors.onSurface }]}>Host 列表</Text>
                <Text style={[styles.cardHint, { color: theme.colors.onSurfaceVariant }]}>选择 Host，分别保存地址、模式与 Token</Text>
              </View>
              <Pressable
                accessibilityLabel="新增 Host"
                accessibilityRole="button"
                disabled={submitting}
                hitSlop={8}
                onPress={addHost}
                style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
                testID="connection-add"
              >
                <MaterialCommunityIcons color={theme.colors.primary} name="plus" size={23} />
                <Text style={[styles.addButtonLabel, { color: theme.colors.primary }]}>新增</Text>
              </Pressable>
            </View>

            <View accessibilityLabel="已保存的 Host" testID="connection-host-list">
              {connection.hosts.map((host) => {
                const selected = host.connectionId === connection.selectedConnectionId;
                return (
                  <Pressable
                    accessibilityLabel={`${host.address}${selected ? '，当前 Host' : ''}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    disabled={submitting || editing}
                    key={host.connectionId}
                    onPress={() => void switchHost(host)}
                    style={({ pressed }) => [
                      styles.hostRow,
                      { borderBottomColor: theme.colors.outlineVariant },
                      selected && { backgroundColor: theme.colors.secondaryContainer },
                      pressed && styles.hostRowPressed,
                    ]}
                    testID={`connection-host-${host.connectionId}`}
                  >
                    <View style={[styles.hostStatusIcon, { backgroundColor: selected ? theme.colors.primary : theme.colors.surfaceVariant }]}>
                      <MaterialCommunityIcons color={selected ? theme.colors.onPrimary : theme.colors.onSurfaceVariant} name={selected ? 'check' : 'cloud-outline'} size={19} />
                    </View>
                    <View style={styles.hostCopy}>
                      <Text ellipsizeMode="middle" numberOfLines={1} style={[styles.hostAddress, { color: theme.colors.onSurface }]}>{host.address}</Text>
                      <Text style={[styles.hostMode, { color: theme.colors.onSurfaceVariant }]}>{host.mode === 'development' ? '开发模式' : '生产模式'} · 凭证按 Host 独立保护</Text>
                    </View>
                    {selected ? <Text style={[styles.selectedLabel, { color: theme.colors.primary }]}>当前</Text> : null}
                    <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="chevron-right" size={20} />
                  </Pressable>
                );
              })}
              {connection.hosts.length === 0 ? (
                <Text style={[styles.emptyHosts, { color: theme.colors.onSurfaceVariant }]}>还没有保存 Host，请新增一个连接。</Text>
              ) : null}
            </View>

            <SettingRow icon="web" label="Cloud Host" theme={theme}>
              {editing ? (
                <TextInput
                  accessibilityLabel="Host URL"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  onChangeText={(hostUrl) => updateForm({ hostUrl })}
                  placeholder={form.developmentMode ? 'ws://127.0.0.1:8787' : 'https://host.example.com'}
                  placeholderTextColor={theme.colors.onSurfaceVariant}
                  style={[styles.settingInput, { color: theme.colors.onSurface }, errors.hostUrl !== undefined && styles.inputError]}
                  testID="connection-host-url"
                  value={form.hostUrl}
                />
              ) : (
                <Text ellipsizeMode="middle" numberOfLines={1} style={[styles.settingValue, { color: theme.colors.onSurfaceVariant }]}>
                  {connection.selectedHost?.address ?? '尚未配置'}
                </Text>
              )}
            </SettingRow>
            {errors.hostUrl !== undefined ? <Text style={[styles.errorText, { color: theme.colors.error }]}>{errors.hostUrl}</Text> : null}

            <SettingRow icon="lock-outline" label="Token" theme={theme}>
              {editing ? (
                <TextInput
                  accessibilityLabel="Token"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(token) => updateForm({ token })}
                  placeholder="输入新 Token"
                  placeholderTextColor={theme.colors.onSurfaceVariant}
                  secureTextEntry
                  style={[styles.settingInput, { color: theme.colors.onSurface }, errors.token !== undefined && styles.inputError]}
                  testID="connection-token"
                  value={form.token}
                />
              ) : (
                <Text style={[styles.settingValue, { color: theme.colors.onSurfaceVariant }]}>已保护</Text>
              )}
            </SettingRow>
            {errors.token !== undefined ? <Text style={[styles.errorText, { color: theme.colors.error }]}>{errors.token}</Text> : null}

            <View style={[styles.settingRow, { borderBottomColor: theme.colors.outlineVariant }]}>
              <View style={[styles.settingIcon, { backgroundColor: theme.colors.surfaceVariant }]}>
                <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="flask-outline" size={20} />
              </View>
              <View style={styles.settingCopy}>
                <Text style={[styles.settingLabel, { color: theme.colors.onSurface }]}>开发模式</Text>
                <Text style={[styles.settingDescription, { color: theme.colors.onSurfaceVariant }]}>允许使用 ws:// 或 http://</Text>
              </View>
              <Switch
                accessibilityLabel="开发模式"
                disabled={!editing || submitting}
                onValueChange={(developmentMode) => updateForm({ developmentMode })}
                testID="connection-development-mode"
                value={form.developmentMode}
              />
            </View>

            {connection.operationError !== undefined ? (
              <View style={[styles.inlineError, { backgroundColor: theme.colors.errorContainer }]}>
                <MaterialCommunityIcons color={theme.colors.onErrorContainer} name="alert-circle-outline" size={20} />
                <Text style={[styles.inlineErrorText, { color: theme.colors.onErrorContainer }]}>
                  {runtimeErrorLabel(connection.operationError.code)}
                </Text>
              </View>
            ) : null}

            {editing ? (
              <Pressable
                accessibilityLabel="连接 Host"
                accessibilityRole="button"
                disabled={submitting}
                onPress={() => void submit()}
                style={({ pressed }) => [styles.primaryButton, { backgroundColor: theme.colors.primary }, pressed && styles.primaryPressed]}
                testID="connection-submit"
              >
                {submitting ? <ActivityIndicator color={theme.colors.onPrimary} /> : <MaterialCommunityIcons color={theme.colors.onPrimary} name="connection" size={20} />}
                <Text style={[styles.primaryButtonLabel, { color: theme.colors.onPrimary }]}>{submitting ? '连接中' : hasSavedConnection ? '保存并连接' : '连接 Host'}</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityLabel="使用已保存连接"
                accessibilityRole="button"
                disabled={!connection.tokenAvailable || submitting}
                onPress={() => void reconnect()}
                style={({ pressed }) => [styles.primaryButton, { backgroundColor: theme.colors.primary }, pressed && styles.primaryPressed, (!connection.tokenAvailable || submitting) && styles.disabledButton]}
                testID="connection-submit"
              >
                {submitting ? <ActivityIndicator color={theme.colors.onPrimary} /> : <MaterialCommunityIcons color={theme.colors.onPrimary} name="refresh" size={20} />}
                <Text style={[styles.primaryButtonLabel, { color: theme.colors.onPrimary }]}>重连 Host</Text>
              </Pressable>
            )}
          </GlassSurface>

          <View style={styles.privacyNote}>
            <MaterialCommunityIcons color={theme.colors.onSurfaceVariant} name="shield-check-outline" size={17} />
            <Text style={[styles.footerNote, { color: theme.colors.onSurfaceVariant }]}>Token 不进入 URL、日志或会话内容。</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

interface SettingRowProps {
  readonly children: ReactNode;
  readonly icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  readonly label: string;
  readonly theme: MD3Theme;
}

function SettingRow(props: SettingRowProps): JSX.Element {
  return (
    <View style={[styles.settingRow, { borderBottomColor: props.theme.colors.outlineVariant }]}>
      <View style={[styles.settingIcon, { backgroundColor: props.theme.colors.surfaceVariant }]}>
        <MaterialCommunityIcons color={props.theme.colors.onSurfaceVariant} name={props.icon} size={20} />
      </View>
      <Text style={[styles.settingLabel, styles.settingLabelWide, { color: props.theme.colors.onSurface }]}>{props.label}</Text>
      <View style={styles.settingValueContainer}>{props.children}</View>
    </View>
  );
}

export interface ConnectionScreenState {
  readonly hosts: readonly ConnectionPreferences[];
  readonly selectedConnectionId: ConnectionId | undefined;
  readonly selectedHost: ConnectionPreferences | undefined;
  /** Compatibility selectors for the former single-Host settings card. */
  readonly savedAddress: string | undefined;
  readonly savedMode: 'development' | 'production' | undefined;
  readonly tokenAvailable: boolean;
  readonly syncStatus: CloudRuntimeState['sync']['status'];
  readonly operationError: CloudRuntimeState['operationError'];
}

export function selectConnectionScreenState(state: CloudRuntimeState): ConnectionScreenState {
  const selectedConnectionId = state.selectedConnectionId;
  const selectedHost = state.savedConnections.find((host) => host.connectionId === selectedConnectionId)
    ?? state.savedConnection;
  return {
    hosts: state.savedConnections,
    selectedConnectionId,
    selectedHost,
    savedAddress: selectedHost?.address,
    savedMode: selectedHost?.mode,
    tokenAvailable: state.tokenAvailable,
    syncStatus: state.sync.status,
    operationError: state.operationError,
  };
}

function connectionStatusLabel(status: ConnectionScreenState['syncStatus']): string {
  switch (status) {
    case 'connected': return '已连接';
    case 'connecting': return '连接中';
    case 'reconnecting': return '重新连接中';
    case 'paused': return '已暂停';
    case 'error': return '连接错误';
    case 'replaced': return '连接已替换';
    case 'idle': return '未连接';
  }
}

function syncStatusColor(status: ConnectionScreenState['syncStatus'], theme: MD3Theme): string {
  switch (status) {
    case 'connected': return theme.colors.tertiary;
    case 'connecting':
    case 'reconnecting': return theme.colors.secondary;
    case 'error':
    case 'replaced': return theme.colors.error;
    case 'paused':
    case 'idle': return theme.colors.outline;
  }
}

function runtimeErrorLabel(code: string): string {
  switch (code) {
    case 'STORAGE_UNAVAILABLE': return '连接配置保存失败，请稍后重试';
    case 'CONNECTION': return '无法连接 Host，请检查地址与网络';
    case 'TIMEOUT': return 'Host 响应超时，请重试';
    case 'CLOSED': return '连接已关闭，请重试';
    case 'PROTOCOL': return 'Host 返回了无法识别的数据';
    default: return '连接失败，请检查配置后重试';
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  content: {
    paddingHorizontal: CLOUD_DESIGN_TOKENS.spacingPage,
    paddingTop: 8,
    gap: CLOUD_DESIGN_TOKENS.spacingSection,
  },
  ambient: {
    position: 'absolute',
    width: 280,
    height: 280,
    top: -130,
    right: -100,
    borderRadius: 140,
    opacity: 0.18,
  },
  hero: {
    minHeight: 286,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingTop: 20,
    paddingBottom: 2,
  },
  headerIcon: {
    position: 'absolute',
    top: 0,
    left: -8,
    width: CLOUD_DESIGN_TOKENS.minTouchTarget,
    height: CLOUD_DESIGN_TOKENS.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: CLOUD_DESIGN_TOKENS.minTouchTarget / 2,
  },
  editButton: {
    position: 'absolute',
    top: 0,
    right: -8,
    minWidth: 58,
    height: CLOUD_DESIGN_TOKENS.minTouchTarget,
    paddingHorizontal: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  editLabel: { fontSize: 15, fontWeight: '600' },
  pressed: { backgroundColor: 'rgba(47,107,255,0.10)' },
  heroMark: {
    width: 70,
    height: 70,
    marginBottom: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: '#111216',
    shadowColor: '#111216',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  eyebrow: { fontSize: 13, lineHeight: 18, letterSpacing: 0.2 },
  heroTitle: { marginTop: 4, fontSize: 46, lineHeight: 54, fontWeight: '800', letterSpacing: -1.8 },
  statusPill: { minHeight: 44, marginTop: 4, flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusDot: { width: 9, height: 9, borderRadius: 5 },
  statusText: { fontSize: 17, lineHeight: 24 },
  connectionCard: { padding: 18, borderRadius: CLOUD_DESIGN_TOKENS.radiusCard, gap: 0 },
  cardHeader: { minHeight: 48, marginBottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: 20, lineHeight: 26, fontWeight: '700', letterSpacing: -0.3 },
  cardHint: { marginTop: 3, fontSize: 13, lineHeight: 19 },
  addButton: { minHeight: 44, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 3, borderRadius: 14 },
  addButtonLabel: { fontSize: 14, lineHeight: 20, fontWeight: '700' },
  hostRow: { minHeight: 68, paddingHorizontal: 8, paddingVertical: 8, marginHorizontal: -8, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderRadius: 14 },
  hostRowPressed: { opacity: 0.72 },
  hostStatusIcon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  hostCopy: { flex: 1, minWidth: 0 },
  hostAddress: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  hostMode: { marginTop: 2, fontSize: 12, lineHeight: 17 },
  selectedLabel: { fontSize: 12, lineHeight: 17, fontWeight: '700' },
  emptyHosts: { paddingVertical: 14, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  settingRow: { minHeight: 68, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  settingIcon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  settingCopy: { flex: 1, minWidth: 0 },
  settingLabel: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  settingLabelWide: { width: 86 },
  settingDescription: { marginTop: 2, fontSize: 12, lineHeight: 17 },
  settingValueContainer: { minWidth: 0, flex: 1, alignItems: 'flex-end' },
  settingValue: { maxWidth: '100%', fontSize: 13, lineHeight: 19, textAlign: 'right' },
  settingInput: { width: '100%', minHeight: 44, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: '#D2D7E0', borderRadius: 12, fontSize: 13, textAlign: 'right' },
  inputError: { borderColor: '#BA1A1A' },
  errorText: { marginTop: 5, marginLeft: 46, fontSize: 12, lineHeight: 17 },
  inlineError: { minHeight: 48, marginTop: 12, paddingHorizontal: 12, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineErrorText: { flex: 1, fontSize: 13, lineHeight: 18 },
  primaryButton: { minHeight: 52, marginTop: 18, paddingHorizontal: 18, borderRadius: 26, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, shadowColor: '#2F6BFF', shadowOpacity: 0.20, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 3 },
  primaryPressed: { transform: [{ scale: 0.98 }], opacity: 0.92 },
  disabledButton: { opacity: 0.52, shadowOpacity: 0 },
  primaryButtonLabel: { fontSize: 16, lineHeight: 22, fontWeight: '700' },
  privacyNote: { minHeight: 44, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  footerNote: { fontSize: 12, lineHeight: 18 },
});
