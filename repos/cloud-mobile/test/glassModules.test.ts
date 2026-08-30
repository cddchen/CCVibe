import { describe, expect, it } from 'vitest';

import {
  inspectLiquidGlassModule,
  isLiquidGlassModuleShape,
} from '../src/ui/glass/liquidGlass';
import { isBlurModuleShape } from '../src/ui/glass/blurMaterial';

describe('material module seams', () => {
  it('accepts the expo-glass-effect 0.1.10 API shape', () => {
    const inspected = inspectLiquidGlassModule({
      GlassView: () => null,
      isLiquidGlassAvailable: () => true,
      isGlassEffectAPIAvailable: () => true,
    });

    expect(inspected).toEqual({
      moduleAvailable: true,
      liquidGlassAvailable: true,
      glassEffectApiAvailable: true,
    });
    expect(isLiquidGlassModuleShape({
      GlassView: () => null,
      isLiquidGlassAvailable: () => false,
      isGlassEffectAPIAvailable: () => false,
    })).toBe(true);
  });

  it('turns a throwing Liquid Glass module into unavailable capability', () => {
    expect(inspectLiquidGlassModule({
      GlassView: () => null,
      isLiquidGlassAvailable: () => {
        throw new Error('native module unavailable');
      },
      isGlassEffectAPIAvailable: () => true,
    })).toEqual({
      moduleAvailable: false,
      liquidGlassAvailable: false,
      glassEffectApiAvailable: false,
    });
  });

  it('treats a missing or malformed blur module as unavailable', () => {
    expect(isBlurModuleShape({ BlurView: () => null })).toBe(true);
    expect(isBlurModuleShape({ BlurView: undefined })).toBe(false);
    expect(isBlurModuleShape(null)).toBe(false);
  });
});
