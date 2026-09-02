import type { JSX } from 'react';
import { Redirect } from 'expo-router';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useCloudSelector } from '../src/features/runtime/CloudRuntimeProvider';
import { selectRootCatalog } from '../src/features/runtime/runtimeStore';

export default function HomeRoute(): JSX.Element {
  const phase = useCloudSelector((state) => state.phase);
  const syncStatus = useCloudSelector((state) => state.sync.status);
  const catalog = useCloudSelector(selectRootCatalog);

  if (phase === 'unconfigured' || phase === 'error') return <Redirect href="/connection" />;
  if (syncStatus === 'connected' && catalog !== undefined) return <Redirect href="/home" />;
  if (phase === 'ready' && (syncStatus === 'error' || syncStatus === 'reconnecting' || syncStatus === 'paused' || syncStatus === 'replaced')) {
    return <Redirect href="/connection" />;
  }
  return <View accessibilityLabel="正在验证 Host 连接" style={styles.loading}><ActivityIndicator size="large" /></View>;
}

const styles = StyleSheet.create({ loading: { alignItems: 'center', flex: 1, justifyContent: 'center' } });
