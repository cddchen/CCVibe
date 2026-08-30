import type { ClientPlatform } from '../../domain/runtimeBoundary';

export type GlassCapability = 'liquidGlass' | 'blur' | 'webBlur' | 'solid' | 'material';

export interface ResolveGlassCapabilityInput {
  readonly platform: ClientPlatform;
  readonly iosMajorVersion?: number;
  readonly liquidGlassAvailable: boolean;
  /** `isGlassEffectAPIAvailable()` from expo-glass-effect 0.1.10. */
  readonly glassEffectApiAvailable?: boolean;
  /** Alias for callers that name the native check by its runtime role. */
  readonly runtimeApiAvailable?: boolean;
  readonly blurAvailable: boolean;
  readonly webBlurAvailable?: boolean;
  readonly isTesting?: boolean;
  readonly reduceTransparency: boolean;
}

/**
 * Pure material selection; native capability, OS version, and accessibility
 * state are injected at the platform edge.
 *
 * Reduce Transparency and test mode are intentionally checked first. Android
 * then has one non-Apple path: Material 3. Liquid Glass is only valid when
 * all three iOS requirements are true, so a missing or failed native check
 * naturally falls through to blur and then to an opaque surface.
 */
export function resolveGlassCapability(input: ResolveGlassCapabilityInput): GlassCapability {
  if (input.reduceTransparency || input.isTesting === true) {
    return 'solid';
  }
  if (input.platform === 'android') {
    return 'material';
  }
  if (input.platform === 'ios') {
    const runtimeApiAvailable = input.glassEffectApiAvailable ?? input.runtimeApiAvailable ?? false;
    const supportsLiquidGlass = input.iosMajorVersion !== undefined && input.iosMajorVersion >= 26;
    if (supportsLiquidGlass && input.liquidGlassAvailable && runtimeApiAvailable) {
      return 'liquidGlass';
    }
    if (input.blurAvailable) {
      return 'blur';
    }
  }
  if (input.platform === 'web' && input.webBlurAvailable === true) {
    return 'webBlur';
  }
  return 'solid';
}
