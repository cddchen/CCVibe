import { describe, expect, it } from 'vitest';
import type { MD3Theme } from 'react-native-paper';

import { createCloudTheme } from '../src/ui/theme/cloudTheme';

const baseTheme = {
  colors: {
    surface: '#FFFFFF',
    background: '#FFFFFF',
  },
} as unknown as MD3Theme;

describe('Cloud MD3 theme', () => {
  it('keeps light and dark semantic colors readable and distinct', () => {
    const light = createCloudTheme(baseTheme, 'light');
    const dark = createCloudTheme(baseTheme, 'dark');

    expect(light.colors.background).toBe('#F7F8FC');
    expect(light.colors.onBackground).toBe('#171A21');
    expect(dark.colors.background).toBe('#101218');
    expect(dark.colors.onBackground).toBe('#E2E2EA');
    expect(light.colors.onSurface).not.toBe(dark.colors.onSurface);
    expect(light.colors.onSurfaceVariant).not.toBe(dark.colors.onSurfaceVariant);
  });

  it('returns a fresh theme object without mutating the Paper base theme', () => {
    const first = createCloudTheme(baseTheme, 'dark');
    const second = createCloudTheme(baseTheme, 'dark');

    expect(first).not.toBe(second);
    expect(first.colors).not.toBe(second.colors);
  });
});
