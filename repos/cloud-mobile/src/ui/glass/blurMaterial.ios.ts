import { Platform } from 'react-native';

import {
  isBlurModuleShape,
  type BlurModule,
  type BlurViewComponent,
} from './blurMaterialShared';

let cachedModule: BlurModule | null | undefined;

function loadBlurModule(): BlurModule | null {
  if (cachedModule !== undefined) {
    return cachedModule;
  }
  if (Platform.OS !== 'ios') {
    cachedModule = null;
    return cachedModule;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const candidate: unknown = require('expo-blur');
    cachedModule = isBlurModuleShape(candidate) ? candidate : null;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export function getBlurViewComponent(): BlurViewComponent | null {
  return loadBlurModule()?.BlurView ?? null;
}
