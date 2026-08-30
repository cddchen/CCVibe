import type { BlurViewComponent } from './blurMaterialShared';

export { isBlurModuleShape } from './blurMaterialShared';
export type {
  BlurModule,
  BlurTint,
  BlurViewComponent,
  BlurViewProps,
} from './blurMaterialShared';

/** The base seam is inert on Android and web; only the iOS file loads expo-blur. */
export function getBlurViewComponent(): BlurViewComponent | null {
  return null;
}
