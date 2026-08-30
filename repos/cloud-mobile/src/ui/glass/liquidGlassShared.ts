import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';

export type LiquidGlassEffectStyle =
  | 'clear'
  | 'regular'
  | 'none'
  | Readonly<{
      readonly style: 'clear' | 'regular' | 'none';
      readonly animate?: boolean;
      readonly animationDuration?: number;
    }>;

export type LiquidGlassViewProps = ViewProps & Readonly<{
  readonly glassEffectStyle?: LiquidGlassEffectStyle;
  readonly tintColor?: string;
  readonly isInteractive?: boolean;
  readonly colorScheme?: 'auto' | 'light' | 'dark';
}>;

export type LiquidGlassViewComponent = ComponentType<LiquidGlassViewProps>;

export interface LiquidGlassModule {
  readonly GlassView: LiquidGlassViewComponent;
  readonly isLiquidGlassAvailable: () => boolean;
  readonly isGlassEffectAPIAvailable: () => boolean;
}

export interface LiquidGlassInspection {
  readonly moduleAvailable: boolean;
  readonly liquidGlassAvailable: boolean;
  readonly glassEffectApiAvailable: boolean;
}

const UNAVAILABLE: LiquidGlassInspection = Object.freeze({
  moduleAvailable: false,
  liquidGlassAvailable: false,
  glassEffectApiAvailable: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

export function isLiquidGlassModuleShape(value: unknown): value is LiquidGlassModule {
  return isRecord(value)
    && isCallable(value.GlassView)
    && isCallable(value.isLiquidGlassAvailable)
    && isCallable(value.isGlassEffectAPIAvailable);
}

/**
 * Calls both expo-glass-effect 0.1.10 capability APIs behind one failure
 * boundary. A native bridge exception is an unavailable module, never a
 * reason to let a render reach GlassView.
 */
export function inspectLiquidGlassModule(value: unknown): LiquidGlassInspection {
  if (!isLiquidGlassModuleShape(value)) {
    return UNAVAILABLE;
  }
  try {
    const liquidGlassAvailable = value.isLiquidGlassAvailable();
    const glassEffectApiAvailable = value.isGlassEffectAPIAvailable();
    if (typeof liquidGlassAvailable !== 'boolean' || typeof glassEffectApiAvailable !== 'boolean') {
      return UNAVAILABLE;
    }
    return Object.freeze({
      moduleAvailable: true,
      liquidGlassAvailable,
      glassEffectApiAvailable,
    });
  } catch {
    return UNAVAILABLE;
  }
}

export const unavailableLiquidGlassInspection = UNAVAILABLE;
