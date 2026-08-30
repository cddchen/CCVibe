import { Platform } from 'react-native';

import {
  inspectLiquidGlassModule,
  isLiquidGlassModuleShape,
  type LiquidGlassInspection,
  type LiquidGlassModule,
  type LiquidGlassViewComponent,
} from './liquidGlassShared';

let cachedModule: LiquidGlassModule | null | undefined;
let cachedInspection: LiquidGlassInspection | undefined;

function loadLiquidGlassModule(): LiquidGlassModule | null {
  if (cachedModule !== undefined) {
    return cachedModule;
  }
  if (Platform.OS !== 'ios') {
    cachedModule = null;
    return cachedModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const candidate: unknown = require('expo-glass-effect');
    cachedModule = isLiquidGlassModuleShape(candidate) ? candidate : null;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export function getLiquidGlassInspection(): LiquidGlassInspection {
  if (cachedInspection !== undefined) {
    return cachedInspection;
  }
  cachedInspection = inspectLiquidGlassModule(loadLiquidGlassModule());
  return cachedInspection;
}

export function getGlassViewComponent(): LiquidGlassViewComponent | null {
  return loadLiquidGlassModule()?.GlassView ?? null;
}
