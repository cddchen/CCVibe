import { describe, expect, it } from 'vitest';

import type { MD3Theme } from 'react-native-paper';

import {
  createMaterialTokens,
  getMaterialSurfaceStyle,
  type MaterialDynamicScheme,
} from '../src/ui/material/materialTokens';

const theme = {
  colors: {
    primary: '#6750A4',
    primaryContainer: '#EADDFF',
    secondary: '#625B71',
    secondaryContainer: '#E8DEF8',
    tertiary: '#7D5260',
    tertiaryContainer: '#FFD8E4',
    surface: '#FFFBFE',
    surfaceVariant: '#E7E0EC',
    surfaceDisabled: '#1D1B201F',
    background: '#FFFBFE',
    error: '#B3261E',
    errorContainer: '#F9DEDC',
    onPrimary: '#FFFFFF',
    onPrimaryContainer: '#21005D',
    onSecondary: '#FFFFFF',
    onSecondaryContainer: '#1D192B',
    onTertiary: '#FFFFFF',
    onTertiaryContainer: '#31111D',
    onSurface: '#1D1B20',
    onSurfaceVariant: '#49454F',
    onError: '#FFFFFF',
    onErrorContainer: '#410E0B',
    onBackground: '#1D1B20',
    outline: '#79747E',
    outlineVariant: '#CAC4D0',
    inverseSurface: '#322F35',
    inverseOnSurface: '#F5EFF7',
    inversePrimary: '#D0BCFF',
    shadow: '#000000',
    scrim: '#000000',
    backdrop: '#00000066',
    elevation: {
      level0: '#FFFBFE',
      level1: '#F7F2FA',
      level2: '#F3EDF7',
      level3: '#EEE8F0',
      level4: '#EAE4EC',
      level5: '#E6E0E9',
    },
  },
} as unknown as MD3Theme;

describe('Material 3 semantic tokens', () => {
  it('merges a dynamic scheme over the Paper theme', () => {
    const dynamicScheme: MaterialDynamicScheme = {
      primary: '#006A6A',
      surface: '#F8FAFA',
      surfaceContainer: '#EAF3F2',
      surfaceContainerHigh: '#DDE9E8',
      onSurface: '#172020',
    };

    const tokens = createMaterialTokens(theme, dynamicScheme);

    expect(tokens.primary).toBe('#006A6A');
    expect(tokens.surface).toBe('#F8FAFA');
    expect(tokens.surfaceContainer).toBe('#EAF3F2');
    expect(tokens.surfaceContainerHigh).toBe('#DDE9E8');
    expect(tokens.onSurface).toBe('#172020');
    expect(tokens.outline).toBe('#79747E');
  });

  it('provides stable Material shapes, elevations, and semantic surface styles', () => {
    const tokens = createMaterialTokens(theme);
    const style = getMaterialSurfaceStyle(tokens, {
      tone: 'surfaceContainerHigh',
      elevation: 3,
      shape: 'large',
    });

    expect(tokens.shape.medium).toBe(12);
    expect(tokens.shape.large).toBe(16);
    expect(tokens.elevation[3]).toBe(6);
    expect(style).toMatchObject({
      backgroundColor: '#E7E0EC',
      borderRadius: 16,
      elevation: 6,
    });
  });
});
