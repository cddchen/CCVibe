import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState, type JSX } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Button,
  HelperText,
  IconButton,
  Switch,
  Text,
  TextInput,
  useTheme,
  type MD3Theme,
} from 'react-native-paper';

import {
  useCloudActions,
  useCloudSelector,
} from '../runtime/CloudRuntimeProvider';
import { validateConnectionForm, type ConnectionFormValues } from './connectionForm';
import type { CloudRuntimeState } from '../runtime/runtimeStore';
import { GlassSurface } from '../../ui/glass/GlassSurface';

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
  const hasEditedForm = useRef(false);

  useEffect(() => {
    const savedAddress = connection.savedAddress;
    if (hasEditedForm.current || savedAddress === undefined) return;
    setForm((current) => ({
      ...current,
      hostUrl: savedAddress,
      developmentMode: connection.savedMode === 'development',
    }));
  }, [connection.savedAddress, connection.savedMode]);

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
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const result = await actions.connect(form);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
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

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingTop: Math.max(insets.top, 8), paddingBottom: Math.max(insets.bottom, 24) },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <IconButton
              accessibilityLabel="返回首页"
              icon={({ color, size }) => <MaterialCommunityIcons color={color} name="chevron-left" size={size} />}
              onPress={() => router.replace('/')}
              size={48}
              style={styles.headerButton}
            />
            <Text variant="headlineSmall" style={styles.headerTitle}>连接 Host</Text>
            <View style={styles.headerSpacer} />
          </View>

          <GlassSurface
            materialElevation={1}
            materialShape="large"
            materialTone="surfaceContainer"
            style={styles.formSurface}
          >
            <Text variant="titleLarge" style={styles.surfaceTitle}>连接设置</Text>
            <Text variant="bodyMedium" style={[styles.surfaceHint, { color: theme.colors.onSurfaceVariant }]}>
              输入 Host 地址与访问 Token
            </Text>

            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              error={errors.hostUrl !== undefined}
              keyboardType="url"
              label="Host URL"
              mode="outlined"
              onChangeText={(hostUrl) => updateForm({ hostUrl })}
              placeholder={form.developmentMode ? 'ws://127.0.0.1:8787' : 'https://host.example.com'}
              value={form.hostUrl}
              style={styles.input}
              testID="connection-host-url"
            />
            <HelperText type="error" visible={errors.hostUrl !== undefined}>
              {errors.hostUrl ?? ''}
            </HelperText>

            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              error={errors.token !== undefined}
              label="Token"
              mode="outlined"
              onChangeText={(token) => updateForm({ token })}
              secureTextEntry
              value={form.token}
              style={styles.input}
              testID="connection-token"
            />
            <HelperText type="error" visible={errors.token !== undefined}>
              {errors.token ?? ''}
            </HelperText>

            <View style={styles.switchRow}>
              <View style={styles.switchCopy}>
                <Text variant="titleMedium">开发模式</Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  允许使用 ws:// 或 http://
                </Text>
              </View>
              <Switch
                accessibilityLabel="开发模式"
                onValueChange={(developmentMode) => updateForm({ developmentMode })}
                value={form.developmentMode}
                testID="connection-development-mode"
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

            <Button
              accessibilityLabel="连接 Host"
              disabled={submitting}
              icon={({ color, size }) => <MaterialCommunityIcons color={color} name="connection" size={size} />}
              mode="contained"
              onPress={() => void submit()}
              style={styles.primaryButton}
              contentStyle={styles.buttonContent}
              testID="connection-submit"
            >
              {submitting ? '连接中' : '连接'}
            </Button>
            {submitting ? <ActivityIndicator accessibilityLabel="正在连接" style={styles.activity} /> : null}
          </GlassSurface>

          {connection.savedAddress !== undefined ? (
            <GlassSurface
              materialElevation={1}
              materialShape="large"
              materialTone="surfaceContainerLow"
              style={styles.savedSurface}
            >
              <View style={styles.savedHeader}>
                <View style={[styles.savedIcon, { backgroundColor: theme.colors.secondaryContainer }]}>
                  <MaterialCommunityIcons color={theme.colors.onSecondaryContainer} name="bookmark-outline" size={22} />
                </View>
                <View style={styles.savedCopy}>
                  <Text variant="titleMedium">已保存连接</Text>
                  <Text numberOfLines={2} style={[styles.savedAddress, { color: theme.colors.onSurfaceVariant }]}>
                    {connection.savedAddress}
                  </Text>
                </View>
              </View>
              <View style={styles.savedStatusRow}>
                <View style={[styles.statusDot, { backgroundColor: syncStatusColor(connection.syncStatus, theme) }]} />
                <Text variant="bodyMedium">{connectionStatusLabel(connection.syncStatus)}</Text>
                <View style={styles.savedStatusSpacer} />
                <Button
                  accessibilityLabel="使用已保存连接"
                  disabled={!connection.tokenAvailable || submitting}
                  icon={({ color, size }) => <MaterialCommunityIcons color={color} name="refresh" size={size} />}
                  mode="text"
                  onPress={() => void reconnect()}
                  compact={false}
                  contentStyle={styles.compactButtonContent}
                >
                  重连
                </Button>
              </View>
            </GlassSurface>
          ) : null}

          <Text variant="bodySmall" style={[styles.footerNote, { color: theme.colors.onSurfaceVariant }]}>
            Token 仅用于当前连接
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

interface ConnectionScreenState {
  readonly savedAddress: string | undefined;
  readonly savedMode: 'development' | 'production' | undefined;
  readonly tokenAvailable: boolean;
  readonly syncStatus: CloudRuntimeState['sync']['status'];
  readonly operationError: CloudRuntimeState['operationError'];
}

function selectConnectionScreenState(state: CloudRuntimeState): ConnectionScreenState {
  return {
    savedAddress: state.savedConnection?.address,
    savedMode: state.savedConnection?.mode,
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
  content: { paddingHorizontal: 20, gap: 16 },
  header: { minHeight: 56, flexDirection: 'row', alignItems: 'center' },
  headerButton: { margin: 0 },
  headerTitle: { flex: 1, textAlign: 'center', fontWeight: '700' },
  headerSpacer: { width: 48 },
  formSurface: { padding: 20, borderRadius: 16, gap: 2 },
  surfaceTitle: { fontWeight: '700' },
  surfaceHint: { marginBottom: 12 },
  input: { marginTop: 8 },
  switchRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  switchCopy: { flex: 1, gap: 3 },
  inlineError: { minHeight: 48, borderRadius: 10, paddingHorizontal: 12, marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  inlineErrorText: { flex: 1 },
  primaryButton: { marginTop: 18, borderRadius: 10 },
  buttonContent: { minHeight: 48 },
  activity: { marginTop: 12 },
  savedSurface: { padding: 18, borderRadius: 16, gap: 12 },
  savedHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  savedIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  savedCopy: { flex: 1, gap: 3 },
  savedAddress: { flexShrink: 1 },
  savedStatusRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 },
  savedStatusSpacer: { flex: 1 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  compactButtonContent: { minHeight: 48 },
  footerNote: { textAlign: 'center', marginTop: 2 },
});
