import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AppState, Platform } from 'react-native';

import {
  CloudRuntime,
  type CloudRuntimeActions,
  type CloudRuntimeDependencies,
  type CloudRuntimeState,
} from './runtimeStore';
import type { AppLifecycleState } from '../../sync/connectionSupervisor';
import { createSecureStoreTokenAdapter } from '../../storage/secureToken';

const RuntimeContext = createContext<CloudRuntime | null>(null);

export interface CloudRuntimeProviderProps {
  readonly children: ReactNode;
  readonly runtime?: CloudRuntime;
}

export function CloudRuntimeProvider(props: CloudRuntimeProviderProps): ReactNode {
  const runtime = useMemo(() => props.runtime ?? createNativeCloudRuntime(), [props.runtime]);

  useEffect(() => {
    void runtime.initialize();
    return () => runtime.dispose();
  }, [runtime]);

  return (
    <RuntimeContext.Provider value={runtime}>
      {props.children}
    </RuntimeContext.Provider>
  );
}

export function useCloudRuntime(): CloudRuntime {
  const runtime = useContext(RuntimeContext);
  if (runtime === null) {
    throw new Error('useCloudRuntime must be used inside CloudRuntimeProvider');
  }
  return runtime;
}

export function useCloudActions(): CloudRuntimeActions {
  return useCloudRuntime().actions;
}

export function useCloudSelector<T>(
  selector: (state: CloudRuntimeState) => T,
  equality: (left: T, right: T) => boolean = Object.is,
): T {
  const runtime = useCloudRuntime();
  const selected = useRef<{ readonly state: CloudRuntimeState; readonly value: T } | null>(null);

  const getSnapshot = useCallback((): T => {
    const state = runtime.getState();
    const previous = selected.current;
    if (previous?.state === state) return previous.value;

    const next = selector(state);
    if (previous !== null && equality(previous.value, next)) {
      selected.current = { state, value: previous.value };
      return previous.value;
    }

    selected.current = { state, value: next };
    return next;
  }, [equality, runtime, selector]);

  const subscribe = useCallback((onStoreChange: () => void) => (
    runtime.subscribe(() => onStoreChange())
  ), [runtime]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function createNativeCloudRuntime(): CloudRuntime {
  const dependencies: CloudRuntimeDependencies = {
    asyncStorage: AsyncStorage,
    tokenStore: createSecureStoreTokenAdapter(SecureStore),
    appState: createNativeAppStatePort(),
    platform: nativePlatform(),
    createId: createRuntimeId,
  };
  return new CloudRuntime(dependencies);
}

function createNativeAppStatePort() {
  return {
    currentState: (): AppLifecycleState => mapAppState(AppState.currentState),
    subscribe: (listener: (state: AppLifecycleState) => void): (() => void) => {
      const subscription = AppState.addEventListener('change', (state) => listener(mapAppState(state)));
      return () => subscription.remove();
    },
  };
}

function mapAppState(state: string): AppLifecycleState {
  switch (state) {
    case 'active': return 'active';
    case 'background': return 'background';
    case 'inactive': return 'inactive';
    default: return 'unknown';
  }
}

function nativePlatform(): NonNullable<CloudRuntimeDependencies['platform']> {
  if (Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web') return Platform.OS;
  return 'unknown';
}

let runtimeIdCounter = 0;

function createRuntimeId(): string {
  runtimeIdCounter += 1;
  return `runtime-${Date.now().toString(36)}-${runtimeIdCounter.toString(36)}`;
}
