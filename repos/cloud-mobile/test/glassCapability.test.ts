import { describe, expect, it } from 'vitest';

import { resolveGlassCapability } from '../src/ui/glass/resolveGlassCapability';

describe('glass capability resolver', () => {
  it('selects Liquid Glass only when iOS 26, the component, and the runtime API are available', () => {
    expect(resolveGlassCapability({
      platform: 'ios',
      iosMajorVersion: 26,
      liquidGlassAvailable: true,
      glassEffectApiAvailable: true,
      blurAvailable: true,
      reduceTransparency: false,
    })).toBe('liquidGlass');
  });

  it('uses blur on older iOS even when the Liquid Glass flags are true', () => {
    expect(resolveGlassCapability({
      platform: 'ios',
      iosMajorVersion: 18,
      liquidGlassAvailable: true,
      glassEffectApiAvailable: true,
      blurAvailable: true,
      reduceTransparency: false,
    })).toBe('blur');
  });

  it('uses blur when the runtime Glass Effect API is unavailable', () => {
    expect(resolveGlassCapability({
      platform: 'ios',
      iosMajorVersion: 26,
      liquidGlassAvailable: true,
      glassEffectApiAvailable: false,
      blurAvailable: true,
      reduceTransparency: false,
    })).toBe('blur');
  });

  it('does not assume Liquid Glass when the iOS version is unknown', () => {
    expect(resolveGlassCapability({
      platform: 'ios',
      liquidGlassAvailable: true,
      glassEffectApiAvailable: true,
      blurAvailable: true,
      reduceTransparency: false,
    })).toBe('blur');
  });

  it('uses a solid surface when the iOS material module cannot provide blur', () => {
    expect(resolveGlassCapability({
      platform: 'ios',
      iosMajorVersion: 18,
      liquidGlassAvailable: false,
      glassEffectApiAvailable: false,
      blurAvailable: false,
      reduceTransparency: false,
    })).toBe('solid');
  });

  it('uses a solid surface in test environments', () => {
    expect(resolveGlassCapability({
      platform: 'ios',
      iosMajorVersion: 26,
      liquidGlassAvailable: true,
      glassEffectApiAvailable: true,
      blurAvailable: true,
      isTesting: true,
      reduceTransparency: false,
    })).toBe('solid');
  });

  it('uses an opaque surface when Reduce Transparency is enabled', () => {
    expect(resolveGlassCapability({
      platform: 'ios',
      iosMajorVersion: 26,
      liquidGlassAvailable: true,
      glassEffectApiAvailable: true,
      blurAvailable: true,
      reduceTransparency: true,
    })).toBe('solid');
  });

  it('selects Material 3 on Android instead of Apple glass or blur', () => {
    expect(resolveGlassCapability({
      platform: 'android',
      liquidGlassAvailable: true,
      glassEffectApiAvailable: true,
      blurAvailable: true,
      webBlurAvailable: true,
      reduceTransparency: false,
    })).toBe('material');
  });

  it('keeps Reduce Transparency stronger than the Android material branch', () => {
    expect(resolveGlassCapability({
      platform: 'android',
      liquidGlassAvailable: true,
      glassEffectApiAvailable: true,
      blurAvailable: true,
      reduceTransparency: true,
    })).toBe('solid');
  });

  it('uses web blur without considering native Liquid Glass', () => {
    expect(resolveGlassCapability({
      platform: 'web',
      liquidGlassAvailable: true,
      glassEffectApiAvailable: true,
      blurAvailable: true,
      webBlurAvailable: true,
      reduceTransparency: false,
    })).toBe('webBlur');
  });
});
