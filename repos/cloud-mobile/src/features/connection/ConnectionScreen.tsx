import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { useEffect, useState, type JSX } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text, useTheme, type MD3Theme } from 'react-native-paper';

import {
  useCloudActions,
  useCloudSelector,
} from '../runtime/CloudRuntimeProvider';
import {
  deriveDevelopmentMode,
  validateConnectionForm,
  type ConnectionFormValues,
} from './connectionForm';
import type { CloudRuntimeState } from '../runtime/runtimeStore';
import type { ConnectionId } from '../../protocol/ids';
import type { ConnectionPreferences } from '../../storage/connectionPreferences';
import { CLOUD_DESIGN_TOKENS } from '../../ui/theme/cloudTheme';

export type ConnectionSettingsView = 'list' | 'edit' | 'new';

type ConnectionFormErrors = Readonly<Partial<Record<'hostUrl' | 'token', string>>>;

const EMPTY_FORM: ConnectionFormValues = Object.freeze({
  hostUrl: '',
  token: '',
  developmentMode: false,
});

export default function ConnectionScreen(): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const theme = useTheme<MD3Theme>();
  const actions = useCloudActions();
  const connection = useCloudSelector(selectConnectionScreenState);
  const [view, setView] = useState<ConnectionSettingsView>('list');
  const [focusedConnectionId, setFocusedConnectionId] = useState<ConnectionId | undefined>();
  const [form, setForm] = useState<ConnectionFormValues>(EMPTY_FORM);
  const [errors, setErrors] = useState<ConnectionFormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [tokenReadError, setTokenReadError] = useState<string | undefined>();

  const focusedHost = focusedConnectionId === undefined
    ? undefined
    : connection.hosts.find((host) => host.connectionId === focusedConnectionId);

  // A second client or another runtime action can remove the row while this
  // screen is open. Return to the stable list instead of rendering a stale
  // editor with credentials for a Host that no longer exists.
  useEffect(() => {
    if (focusedConnectionId === undefined || focusedHost !== undefined) return;
    setFocusedConnectionId(undefined);
    setTokenLoading(false);
    setTokenReadError(undefined);
    setView('list');
  }, [focusedConnectionId, focusedHost]);

  useEffect(() => {
    if (view !== 'edit' || focusedConnectionId === undefined || focusedHost === undefined) return;
    let active = true;
    setTokenLoading(true);
    setTokenReadError(undefined);
    void actions.readHostToken(focusedConnectionId)
      .then((token) => {
        if (!active) return;
        if (token === null || token.trim().length === 0) {
          setForm((current) => ({ ...current, token: '' }));
          setTokenReadError('该 Host 尚未保存 Token，请输入新的 Token');
          return;
        }
        setForm((current) => ({ ...current, token }));
      })
      .catch(() => {
        if (active) setTokenReadError('该 Host 的 Token 读取失败，请稍后重试');
      })
      .finally(() => {
        if (active) setTokenLoading(false);
      });
    return () => {
      active = false;
    };
  }, [actions, focusedConnectionId, focusedHost, view]);
  const heroSubtitle = connection.selectedHost === undefined
    ? '远程移动控制端'
    : connection.selectedHost.mode === 'development'
      ? '远程移动控制端 · 开发环境'
      : '远程移动控制端 · 生产环境';

  const updateForm = (patch: Partial<ConnectionFormValues>): void => {
    setForm((current) => {
      const next = { ...current, ...patch };
      if ('hostUrl' in patch) next.developmentMode = deriveDevelopmentMode(next.hostUrl);
      return next;
    });
    if ('hostUrl' in patch && errors.hostUrl !== undefined) {
      setErrors((current) => ({ ...current, hostUrl: undefined }));
    }
    if ('token' in patch && errors.token !== undefined) {
      setErrors((current) => ({ ...current, token: undefined }));
    }
    if ('token' in patch && patch.token !== undefined && patch.token.trim().length > 0 && tokenReadError !== undefined) {
      setTokenReadError(undefined);
    }
  };

  const showList = (): void => {
    setView('list');
    setErrors({});
    setFocusedConnectionId(undefined);
    setTokenLoading(false);
    setTokenReadError(undefined);
  };

  const goBack = (): void => {
    if (view === 'list') {
      // The list is the route boundary. Native back preserves the interactive
      // iOS gesture and Android back stack semantics.
      router.back();
      return;
    }
    showList();
  };

  const openEdit = (host: ConnectionPreferences): void => {
    setFocusedConnectionId(host.connectionId);
    setTokenLoading(true);
    setTokenReadError(undefined);
    setForm(formForHost(host));
    setErrors({});
    setView('edit');
  };

  const connectHost = async (host: ConnectionPreferences): Promise<void> => {
    setErrors({});
    setSubmitting(true);
    try {
      const result = await actions.switchConnection(host.connectionId);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      router.replace('/');
    } finally {
      setSubmitting(false);
    }
  };

  const openNew = (): void => {
    setFocusedConnectionId(undefined);
    setTokenLoading(false);
    setTokenReadError(undefined);
    setForm(EMPTY_FORM);
    setErrors({});
    setView('new');
  };

  const save = async (): Promise<void> => {
    const validation = validateConnectionForm(form);
    if (!validation.ok && !(view === 'edit' && canKeepStoredToken(validation))) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const result = await actions.saveConnection(
        form,
        view === 'edit' ? focusedConnectionId ?? null : null,
      );
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      showList();
    } finally {
      setSubmitting(false);
    }
  };

  const connect = async (): Promise<void> => {
    const values = form;
    const validation = validateConnectionForm(values);
    if (!validation.ok && !(view === 'edit' && canKeepStoredToken(validation))) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const result = await actions.connect(
        values,
        view === 'edit' ? focusedConnectionId ?? null : null,
      );
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      router.replace('/');
    } finally {
      setSubmitting(false);
    }
  };

  const requestDelete = (): void => {
    if (focusedHost === undefined || submitting) return;
    Alert.alert(
      '删除这台主机？',
      `“${focusedHost.address}”及其连接信息将从此设备移除。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => { void deleteHost(focusedHost.connectionId); },
        },
      ],
    );
  };

  const deleteHost = async (connectionId: ConnectionId): Promise<void> => {
    setSubmitting(true);
    try {
      const result = await actions.deleteConnection(connectionId);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setFocusedConnectionId(undefined);
      showList();
    } finally {
      setSubmitting(false);
    }
  };

  const operationError = connection.operationError === undefined
    ? undefined
    : runtimeErrorLabel(connection.operationError.code);
  const listError = errors.hostUrl ?? errors.token ?? operationError;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 28) }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <Pressable
              accessibilityLabel={view === 'list' ? '返回首页' : '返回主机列表'}
              accessibilityRole="button"
              disabled={submitting}
              onPress={goBack}
              style={({ pressed }) => [
                styles.backButton,
                { backgroundColor: theme.colors.surface },
                pressed && styles.pressed,
              ]}
              testID="connection-back"
            >
              <MaterialCommunityIcons color={theme.colors.onBackground} name="chevron-left" size={29} />
            </Pressable>
            <View style={styles.heroCopy}>
              <View style={styles.heroMark}>
                <MaterialCommunityIcons color="#FFFFFF" name="cloud-outline" size={39} />
              </View>
              <Text allowFontScaling style={[styles.heroTitle, { color: theme.colors.onBackground }]}>Cloud</Text>
              <Text allowFontScaling style={[styles.heroSubtitle, { color: theme.colors.onSurfaceVariant }]}>{heroSubtitle}</Text>
            </View>
          </View>

          {view === 'list' ? (
            <HostList
              hosts={connection.hosts}
              selectedConnectionId={connection.selectedConnectionId}
              disabled={submitting}
              error={listError}
              theme={theme}
              onConnect={connectHost}
              onOpenEdit={openEdit}
              onOpenNew={openNew}
            />
          ) : (
            <HostEditor
              mode={view === 'new' ? 'new' : 'edit'}
              form={form}
              errors={errors}
              disabled={submitting || tokenLoading}
              error={operationError}
              tokenLoading={tokenLoading}
              tokenReadError={tokenReadError}
              theme={theme}
              onChange={updateForm}
              onDelete={view === 'edit' ? requestDelete : undefined}
              onSave={() => { void save(); }}
              onConnect={() => { void connect(); }}
            />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

interface HostListProps {
  readonly hosts: readonly ConnectionPreferences[];
  readonly selectedConnectionId: ConnectionId | undefined;
  readonly disabled: boolean;
  readonly error: string | undefined;
  readonly theme: MD3Theme;
  readonly onConnect: (host: ConnectionPreferences) => void;
  readonly onOpenEdit: (host: ConnectionPreferences) => void;
  readonly onOpenNew: () => void;
}

function HostList(props: HostListProps): JSX.Element {
  return (
    <View style={styles.listSection} testID="connection-list-view">
      <Text allowFontScaling style={[styles.sectionHeading, { color: props.theme.colors.onSurfaceVariant }]}>云端主机</Text>
      <View
        accessibilityLabel="已保存的云端主机"
        style={[styles.hostListSurface, { backgroundColor: props.theme.colors.surface, borderColor: props.theme.colors.outlineVariant }]}
        testID="connection-settings-card"
      >
        <View accessibilityLabel="已保存的云端主机" testID="connection-host-list">
          {props.hosts.map((host, index) => {
            const selected = host.connectionId === props.selectedConnectionId;
            return (
              <View
                key={host.connectionId}
                style={[
                  styles.hostRow,
                  index < props.hosts.length - 1 && {
                    borderBottomColor: props.theme.colors.outlineVariant,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                  },
                ]}
              >
                <Pressable
                  accessibilityLabel={`${host.address}${selected ? '，当前 Host' : ''}`}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  disabled={props.disabled}
                  onPress={() => props.onConnect(host)}
                  style={({ pressed }) => [styles.hostMainPressable, pressed && styles.rowPressed]}
                  testID={`connection-host-${host.connectionId}`}
                >
                  <Text
                    allowFontScaling
                    ellipsizeMode="middle"
                    numberOfLines={1}
                    style={[styles.hostAddress, { color: props.theme.colors.onSurface }]}
                  >
                    {host.address}
                  </Text>
                  <View style={styles.hostTrailing}>
                    {selected ? <MaterialCommunityIcons color={props.theme.colors.primary} name="check" size={22} /> : null}
                  </View>
                </Pressable>
                <Pressable
                  accessibilityLabel={`编辑 ${host.address}`}
                  accessibilityRole="button"
                  disabled={props.disabled}
                  onPress={() => props.onOpenEdit(host)}
                  style={({ pressed }) => [styles.hostEditButton, pressed && styles.rowPressed]}
                  testID={`connection-edit-${host.connectionId}`}
                >
                  <MaterialCommunityIcons color={props.theme.colors.onSurfaceVariant} name="pencil-outline" size={22} />
                </Pressable>
              </View>
            );
          })}
          <Pressable
            accessibilityLabel="新增主机"
            accessibilityRole="button"
            disabled={props.disabled}
            onPress={props.onOpenNew}
            style={({ pressed }) => [
              styles.hostRow,
              styles.addHostRow,
              props.hosts.length > 0 && {
                borderTopColor: props.theme.colors.outlineVariant,
                borderTopWidth: StyleSheet.hairlineWidth,
              },
              pressed && styles.rowPressed,
            ]}
            testID="connection-add"
          >
            <Text allowFontScaling style={[styles.addHostLabel, { color: props.theme.colors.onSurface }]}>新增主机</Text>
            <MaterialCommunityIcons color={props.theme.colors.primary} name="plus" size={23} />
          </Pressable>
        </View>
      </View>
      {props.error === undefined ? null : <InlineError message={props.error} theme={props.theme} />}
      <Text allowFontScaling style={[styles.securityNote, { color: props.theme.colors.onSurfaceVariant }]}>列表仅显示 Host，Token 不会显示在列表中。</Text>
    </View>
  );
}

interface HostEditorProps {
  readonly mode: 'edit' | 'new';
  readonly form: ConnectionFormValues;
  readonly errors: ConnectionFormErrors;
  readonly disabled: boolean;
  readonly error: string | undefined;
  readonly tokenLoading: boolean;
  readonly tokenReadError: string | undefined;
  readonly theme: MD3Theme;
  readonly onChange: (patch: Partial<ConnectionFormValues>) => void;
  readonly onDelete?: () => void;
  readonly onSave: () => void;
  readonly onConnect: () => void;
}

function HostEditor(props: HostEditorProps): JSX.Element {
  const editing = props.mode === 'edit';
  return (
    <View style={styles.formSection} testID="connection-editor-view">
      <View style={styles.titleRow}>
        <Text allowFontScaling style={[styles.formTitle, { color: props.theme.colors.onBackground }]}>{editing ? '编辑主机' : '新增主机'}</Text>
        {editing && props.onDelete !== undefined ? (
          <Pressable
            accessibilityLabel="删除 Host"
            accessibilityRole="button"
            disabled={props.disabled}
            onPress={props.onDelete}
            style={({ pressed }) => [styles.deleteButton, pressed && styles.deletePressed]}
            testID="connection-delete"
          >
            <Text allowFontScaling style={[styles.deleteLabel, { color: props.theme.colors.error }]}>删除</Text>
          </Pressable>
        ) : null}
      </View>
      <LabeledInput
        label="Host"
        value={props.form.hostUrl}
        placeholder="wss://hostname:port"
        error={props.errors.hostUrl}
        theme={props.theme}
        disabled={props.disabled}
        testID="connection-host-url"
        onChangeText={(hostUrl) => props.onChange({ hostUrl })}
      />
      <LabeledInput
        label="Token"
        value={props.form.token}
        placeholder={props.tokenLoading ? '正在读取 Token…' : '输入 Token'}
        error={props.errors.token}
        theme={props.theme}
        disabled={props.disabled}
        secureTextEntry={!editing}
        testID="connection-token"
        onChangeText={(token) => props.onChange({ token })}
      />
      {props.tokenLoading ? (
        <View style={styles.tokenStatus}>
          <ActivityIndicator color={props.theme.colors.primary} size="small" />
          <Text allowFontScaling style={[styles.tokenStatusText, { color: props.theme.colors.onSurfaceVariant }]}>正在读取 Token…</Text>
        </View>
      ) : null}
      <Text allowFontScaling style={[styles.securityNote, { color: props.theme.colors.onSurfaceVariant }]}>
        {editing ? '留空则保留已保存的 Token。' : 'Token 会安全保存，不会显示在列表中。'}
      </Text>
      {props.tokenReadError === undefined ? null : <InlineError message={props.tokenReadError} theme={props.theme} />}
      {props.error === undefined ? null : <InlineError message={props.error} theme={props.theme} />}
      <View style={styles.actionsRow}>
        <Pressable
          accessibilityLabel="保存主机"
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={props.onSave}
          style={({ pressed }) => [styles.secondaryButton, { borderColor: props.theme.colors.outlineVariant, backgroundColor: props.theme.colors.surface }, pressed && styles.secondaryPressed]}
          testID="connection-save"
        >
          <Text allowFontScaling style={[styles.secondaryButtonLabel, { color: props.theme.colors.onSurface }]}>{props.disabled ? '保存中' : '保存'}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel="连接 Host"
          accessibilityRole="button"
          disabled={props.disabled}
          onPress={props.onConnect}
          style={({ pressed }) => [styles.primaryButton, { backgroundColor: props.theme.colors.primary }, pressed && styles.primaryPressed]}
          testID="connection-submit"
        >
          {props.disabled ? <ActivityIndicator color={props.theme.colors.onPrimary} /> : null}
          <Text allowFontScaling style={[styles.primaryButtonLabel, { color: props.theme.colors.onPrimary }]}>{props.disabled ? '连接中' : '连接'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

interface LabeledInputProps {
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly error: string | undefined;
  readonly theme: MD3Theme;
  readonly disabled: boolean;
  readonly secureTextEntry?: boolean;
  readonly testID: string;
  readonly onChangeText: (value: string) => void;
}

function LabeledInput(props: LabeledInputProps): JSX.Element {
  return (
    <View style={styles.fieldGroup}>
      <Text allowFontScaling style={[styles.fieldLabel, { color: props.theme.colors.onSurfaceVariant }]}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        allowFontScaling
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={props.theme.colors.onSurfaceVariant}
        secureTextEntry={props.secureTextEntry}
        style={[styles.fieldInput, { backgroundColor: props.theme.colors.surface, borderColor: props.error === undefined ? props.theme.colors.outlineVariant : props.theme.colors.error, color: props.theme.colors.onSurface }]}
        testID={props.testID}
        value={props.value}
      />
      {props.error === undefined ? null : <Text allowFontScaling style={[styles.fieldError, { color: props.theme.colors.error }]}>{props.error}</Text>}
    </View>
  );
}

interface InlineErrorProps {
  readonly message: string;
  readonly theme: MD3Theme;
}

function InlineError(props: InlineErrorProps): JSX.Element {
  return (
    <View style={[styles.inlineError, { backgroundColor: props.theme.colors.errorContainer }]}>
      <MaterialCommunityIcons color={props.theme.colors.onErrorContainer} name="alert-circle-outline" size={20} />
      <Text allowFontScaling style={[styles.inlineErrorText, { color: props.theme.colors.onErrorContainer }]}>{props.message}</Text>
    </View>
  );
}

export interface ConnectionScreenState {
  readonly hosts: readonly ConnectionPreferences[];
  readonly selectedConnectionId: ConnectionId | undefined;
  readonly selectedHost: ConnectionPreferences | undefined;
  /** Compatibility selectors for callers from the former single-Host settings card. */
  readonly savedAddress: string | undefined;
  readonly savedMode: 'development' | 'production' | undefined;
  readonly tokenAvailable: boolean;
  readonly tokenAvailability: Readonly<Record<string, boolean>>;
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
    tokenAvailability: state.tokenAvailability,
    syncStatus: state.sync.status,
    operationError: state.operationError,
  };
}

export function formForHost(host: ConnectionPreferences): ConnectionFormValues {
  return {
    hostUrl: host.address,
    token: '',
    developmentMode: deriveDevelopmentMode(host.address),
  };
}

function canKeepStoredToken(result: Extract<ReturnType<typeof validateConnectionForm>, { readonly ok: false }>): boolean {
  return result.errors.hostUrl === undefined && result.errors.token !== undefined;
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
    gap: 26,
  },
  hero: {
    minHeight: 274,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingTop: 20,
    paddingBottom: 2,
  },
  heroCopy: { alignItems: 'center', transform: [{ translateY: -44 }] },
  backButton: {
    position: 'absolute',
    top: 14,
    left: -8,
    width: CLOUD_DESIGN_TOKENS.minTouchTarget,
    height: CLOUD_DESIGN_TOKENS.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: CLOUD_DESIGN_TOKENS.minTouchTarget / 2,
  },
  pressed: { opacity: 0.68 },
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
  heroTitle: { fontSize: 34, lineHeight: 38, fontWeight: '800', letterSpacing: -1.2 },
  heroSubtitle: { marginTop: 5, fontSize: 13, lineHeight: 19 },
  listSection: { gap: 0 },
  sectionHeading: { marginHorizontal: 2, marginBottom: 10, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  hostListSurface: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    shadowColor: '#171A21',
    shadowOpacity: 0.07,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  hostRow: {
    minHeight: 58,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  hostMainPressable: { minHeight: CLOUD_DESIGN_TOKENS.minTouchTarget, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  hostEditButton: { width: CLOUD_DESIGN_TOKENS.minTouchTarget, height: CLOUD_DESIGN_TOKENS.minTouchTarget, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  hostTrailing: { minWidth: 45, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 9 },
  hostAddress: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 21 },
  rowPressed: { backgroundColor: 'rgba(47,107,255,0.08)' },
  addHostRow: { borderBottomWidth: 0 },
  addHostLabel: { flex: 1, fontSize: 15, lineHeight: 21, fontWeight: '700' },
  securityNote: { marginTop: 14, paddingHorizontal: 8, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  formSection: { gap: 0 },
  titleRow: { minHeight: 44, marginBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  formTitle: { fontSize: 24, lineHeight: 29, fontWeight: '700', letterSpacing: -0.4 },
  deleteButton: { minWidth: 58, minHeight: CLOUD_DESIGN_TOKENS.minTouchTarget, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  deletePressed: { backgroundColor: 'rgba(186,26,26,0.10)' },
  deleteLabel: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  fieldGroup: { marginTop: 16 },
  fieldLabel: { marginHorizontal: 2, marginBottom: 7, fontSize: 13, lineHeight: 19 },
  fieldInput: { minHeight: 52, paddingHorizontal: 16, paddingVertical: 11, borderWidth: 1, borderRadius: 16, fontSize: 15, lineHeight: 21 },
  fieldError: { marginTop: 5, marginHorizontal: 2, fontSize: 12, lineHeight: 18 },
  tokenStatus: { minHeight: 34, flexDirection: 'row', alignItems: 'center', gap: 8 },
  tokenStatusText: { fontSize: 12, lineHeight: 18 },
  actionsRow: { marginTop: 26, flexDirection: 'row', gap: 12 },
  secondaryButton: { minHeight: 52, flex: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: 28 },
  secondaryPressed: { backgroundColor: 'rgba(23,26,33,0.06)' },
  secondaryButtonLabel: { fontSize: 15, lineHeight: 21, fontWeight: '700' },
  primaryButton: { minHeight: 52, flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 28, shadowColor: '#2F6BFF', shadowOpacity: 0.20, shadowRadius: 12, shadowOffset: { width: 0, height: 5 }, elevation: 3 },
  primaryPressed: { transform: [{ scale: 0.98 }], opacity: 0.90 },
  primaryButtonLabel: { fontSize: 15, lineHeight: 21, fontWeight: '700' },
  inlineError: { minHeight: 48, marginTop: 16, paddingHorizontal: 12, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineErrorText: { flex: 1, fontSize: 13, lineHeight: 19 },
});
