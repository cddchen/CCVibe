import type {
  LiquidGlassInspection,
  LiquidGlassViewComponent,
} from './liquidGlassShared';

export {
  inspectLiquidGlassModule,
  isLiquidGlassModuleShape,
} from './liquidGlassShared';
export type {
  LiquidGlassEffectStyle,
  LiquidGlassInspection,
  LiquidGlassModule,
  LiquidGlassViewComponent,
  LiquidGlassViewProps,
} from './liquidGlassShared';
import { unavailableLiquidGlassInspection } from './liquidGlassShared';

/**
 * The base seam is deliberately inert. Metro selects liquidGlass.ios.ts for
 * iOS; Android and web therefore have no runtime path to the native module.
 */
export function getLiquidGlassInspection(): LiquidGlassInspection {
  return unavailableLiquidGlassInspection;
}

export function getGlassViewComponent(): LiquidGlassViewComponent | null {
  return null;
}
