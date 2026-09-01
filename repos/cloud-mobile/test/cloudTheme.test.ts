import { describe, expect, it } from 'vitest';
import type { MD3Theme } from 'react-native-paper';

import { CLOUD_DESIGN_TOKENS, createCloudTheme } from '../src/ui/theme/cloudTheme';

const baseTheme = {
  colors: {
    surface: '#FFFFFF',
    background: '#FFFFFF',
  },
} as unknown as MD3Theme;

describe('Cloud MD3 theme', () => {
  it('exposes the shared mobile geometry contract used by every material tier', () => {
    expect(CLOUD_DESIGN_TOKENS.background).toBe('#F7F8FC');
    expect(CLOUD_DESIGN_TOKENS.surface).toBe('#FFFFFF');
    expect(CLOUD_DESIGN_TOKENS.radiusCard).toBe(28);
    expect(CLOUD_DESIGN_TOKENS.radiusControl).toBe(24);
    expect(CLOUD_DESIGN_TOKENS.minTouchTarget).toBeGreaterThanOrEqual(44);
  });

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
