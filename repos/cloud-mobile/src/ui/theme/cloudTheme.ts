import type { MD3Theme } from 'react-native-paper';

export type CloudColorScheme = 'light' | 'dark';

const LIGHT_COLORS: Partial<MD3Theme['colors']> = Object.freeze({
  primary: '#2F6BFF',
  onPrimary: '#FFFFFF',
  primaryContainer: '#DCE7FF',
  onPrimaryContainer: '#0A2A73',
  secondary: '#5C6472',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#E7EAF0',
  onSecondaryContainer: '#171B22',
  tertiary: '#1E9E55',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#B7F1C9',
  onTertiaryContainer: '#07391A',
  background: '#F7F8FC',
  onBackground: '#171A21',
  surface: '#FBFCFF',
  surfaceVariant: '#E9ECF3',
  onSurface: '#171A21',
  onSurfaceVariant: '#5E6572',
  outline: '#7C8491',
  outlineVariant: '#D2D7E0',
  error: '#BA1A1A',
  onError: '#FFFFFF',
  errorContainer: '#FFDAD6',
  onErrorContainer: '#410002',
});

const DARK_COLORS: Partial<MD3Theme['colors']> = Object.freeze({
  primary: '#AFC5FF',
  onPrimary: '#092E78',
  primaryContainer: '#1646A5',
  onPrimaryContainer: '#DCE7FF',
  secondary: '#BEC6D4',
  onSecondary: '#29303A',
  secondaryContainer: '#424955',
  onSecondaryContainer: '#E3E7F0',
  tertiary: '#75D996',
  onTertiary: '#00391A',
  tertiaryContainer: '#07522A',
  onTertiaryContainer: '#91F6AB',
  background: '#101218',
  onBackground: '#E2E2EA',
  surface: '#15171E',
  surfaceVariant: '#444750',
  onSurface: '#E2E2EA',
  onSurfaceVariant: '#C4C6D0',
  outline: '#8E9099',
  outlineVariant: '#444750',
  error: '#FFB4AB',
  onError: '#690005',
  errorContainer: '#93000A',
  onErrorContainer: '#FFDAD6',
});

export function createCloudTheme(baseTheme: MD3Theme, scheme: CloudColorScheme): MD3Theme {
  const colors = scheme === 'dark' ? DARK_COLORS : LIGHT_COLORS;

  return {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      ...colors,
    },
  };
}
