import type { ComponentType, ReactNode } from 'react';
import type { ColorValue, ViewProps } from 'react-native';

export type BlurTint =
  | 'light'
  | 'dark'
  | 'default'
  | 'systemUltraThinMaterial'
  | 'systemThinMaterial'
  | 'systemMaterial'
  | 'systemThickMaterial'
  | 'systemChromeMaterial'
  | 'systemUltraThinMaterialLight'
  | 'systemThinMaterialLight'
  | 'systemMaterialLight'
  | 'systemThickMaterialLight'
  | 'systemChromeMaterialLight'
  | 'systemUltraThinMaterialDark'
  | 'systemThinMaterialDark'
  | 'systemMaterialDark'
  | 'systemThickMaterialDark'
  | 'systemChromeMaterialDark';

export interface BlurViewProps extends ViewProps {
  readonly children?: ReactNode;
  readonly tint?: BlurTint;
  readonly intensity?: number;
  readonly experimentalBlurMethod?: 'none' | 'dimezisBlurView';
  readonly blurReductionFactor?: number;
  readonly backgroundColor?: ColorValue;
}

export type BlurViewComponent = ComponentType<BlurViewProps>;

export interface BlurModule {
  readonly BlurView: BlurViewComponent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCallable(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function';
}

export function isBlurModuleShape(value: unknown): value is BlurModule {
  return isRecord(value) && isCallable(value.BlurView);
}
