import type { JSX } from 'react';
import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';
import { MD3DarkTheme, MD3LightTheme, PaperProvider } from 'react-native-paper';

import { CloudRuntimeProvider } from '../src/features/runtime/CloudRuntimeProvider';
import { createCloudTheme } from '../src/ui/theme/cloudTheme';

export default function RootLayout(): JSX.Element {
  const colorScheme = useColorScheme();
  const theme = createCloudTheme(
    colorScheme === 'dark' ? MD3DarkTheme : MD3LightTheme,
    colorScheme === 'dark' ? 'dark' : 'light',
  );

  return (
    <PaperProvider theme={theme}>
      <CloudRuntimeProvider>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="home" />
          <Stack.Screen name="connection" />
          <Stack.Screen name="chat/[chatId]" />
        </Stack>
      </CloudRuntimeProvider>
    </PaperProvider>
  );
}
