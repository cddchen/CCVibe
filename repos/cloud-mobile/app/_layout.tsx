import type { JSX } from 'react';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useColorScheme } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';
import { KeyboardProvider } from 'react-native-keyboard-controller';

import { CloudRuntimeProvider } from '../src/features/runtime/CloudRuntimeProvider';
import { createCloudTheme } from '../src/ui/theme/cloudTheme';

export default function RootLayout(): JSX.Element {
  const colorScheme = useColorScheme();
  const reducedMotion = useReducedMotion();
  const theme = createCloudTheme(
    colorScheme === 'dark' ? MD3DarkTheme : MD3LightTheme,
    colorScheme === 'dark' ? 'dark' : 'light',
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <PaperProvider theme={theme}>
          <CloudRuntimeProvider>
            <Stack
              screenOptions={{
                headerShown: false,
                // Native transitions preserve the interactive iOS back gesture.
                animation: reducedMotion ? 'fade' : 'default',
                animationMatchesGesture: true,
              }}
            >
              <Stack.Screen name="index" />
              <Stack.Screen name="home" />
              <Stack.Screen name="connection" options={{ animation: reducedMotion ? 'fade' : 'slide_from_right' }} />
              <Stack.Screen name="chat/[chatId]" options={{ animation: reducedMotion ? 'fade' : 'default' }} />
            </Stack>
          </CloudRuntimeProvider>
        </PaperProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
