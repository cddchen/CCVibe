import * as React from 'react';
import {
  Platform,
  PlatformColor,
  StyleSheet,
  View,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { MaterialSurface } from '../material/MaterialSurface';
import type {
  MaterialDynamicScheme,
  MaterialElevation,
  MaterialShape,
  MaterialSurfaceTone,
} from '../material/materialTokens';
import { getBlurViewComponent } from './blurMaterial';
import type { BlurViewComponent } from './blurMaterial';
import {
  getGlassViewComponent,
  getLiquidGlassInspection,
  type LiquidGlassEffectStyle,
} from './liquidGlass';
import { resolveGlassCapability, type GlassCapability } from './resolveGlassCapability';
import { useReduceTransparency } from './useReduceTransparency';

export type GlassSurfaceProps = Readonly<{
  children?: React.ReactNode;
  /** Layout and shape only. The material is rendered by this component. */
  style?: StyleProp<ViewStyle>;
  /** `regular` is the default iOS 26 chrome material. */
  glassEffectStyle?: LiquidGlassEffectStyle;
  blurIntensity?: number;
  /** Set false to force the opaque tier while preserving layout. */
  enabled?: boolean;
  solidColor?: ColorValue;
  /** Enables the iOS 26 interactive GlassView behavior for controls. */
  interactive?: boolean;
  materialTone?: MaterialSurfaceTone;
  materialElevation?: MaterialElevation;
  materialShape?: MaterialShape;
  dynamicScheme?: MaterialDynamicScheme;
  testID?: string;
}>;

type WebBlurStyle = ViewStyle & Readonly<{
  backdropFilter: string;
  WebkitBackdropFilter: string;
}>;

const LEGACY_RIM_STYLE: ViewStyle = Object.freeze({
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: 'rgba(255,255,255,0.30)',
});

const IOS_FALLBACK_CHROME_STYLE: ViewStyle = Object.freeze({
  borderWidth: StyleSheet.hairlineWidth,
  borderColor: 'rgba(255,255,255,0.46)',
  shadowColor: '#000000',
  shadowOpacity: 0.10,
  shadowRadius: 9,
  shadowOffset: { width: 0, height: 2 },
});

function getClientPlatform(): 'ios' | 'android' | 'web' | 'unknown' {
  if (Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web') {
    return Platform.OS;
  }
  return 'unknown';
}

function getIOSMajorVersion(): number | undefined {
  if (Platform.OS !== 'ios') {
    return undefined;
  }
  const rawVersion = Platform.Version;
  const majorVersion = typeof rawVersion === 'number'
    ? rawVersion
    : Number.parseInt(rawVersion, 10);
  return Number.isFinite(majorVersion) ? majorVersion : undefined;
}

function isTesting(): boolean {
  return Platform.isTesting === true || Platform.constants.isTesting === true;
}

function getDefaultSolidColor(): ColorValue {
  return Platform.OS === 'ios' ? PlatformColor('systemBackground') : '#FFFFFF';
}

function getSolidColor(props: GlassSurfaceProps, reduceTransparency: boolean): ColorValue {
  return reduceTransparency ? getDefaultSolidColor() : (props.solidColor ?? getDefaultSolidColor());
}

function getWebBlurStyle(): ViewStyle {
  const style: WebBlurStyle = {
    backgroundColor: 'rgba(255,255,255,0.72)',
    backdropFilter: 'blur(10px)',
    WebkitBackdropFilter: 'blur(10px)',
  };
  return style as unknown as ViewStyle;
}

function getCapability(
  props: GlassSurfaceProps,
  reduceTransparency: boolean,
  liquidGlassInspection: ReturnType<typeof getLiquidGlassInspection>,
  blurView: BlurViewComponent | null,
): GlassCapability {
  const platform = getClientPlatform();
  return resolveGlassCapability({
    platform,
    iosMajorVersion: getIOSMajorVersion(),
    liquidGlassAvailable: props.enabled !== false && liquidGlassInspection.liquidGlassAvailable,
    glassEffectApiAvailable: props.enabled !== false && liquidGlassInspection.glassEffectApiAvailable,
    blurAvailable: props.enabled !== false && blurView !== null,
    webBlurAvailable: platform === 'web' && props.enabled !== false,
    isTesting: isTesting(),
    reduceTransparency,
  });
}

function renderLiquidGlass(
  GlassView: NonNullable<ReturnType<typeof getGlassViewComponent>>,
  props: GlassSurfaceProps,
): React.ReactElement {
  return (
    <GlassView
      pointerEvents="none"
      glassEffectStyle={props.glassEffectStyle ?? 'regular'}
      isInteractive={props.interactive === true}
      style={StyleSheet.absoluteFillObject}
    />
  );
}

function renderBlur(
  BlurView: NonNullable<ReturnType<typeof getBlurViewComponent>>,
  props: GlassSurfaceProps,
): React.ReactElement {
  return (
    <BlurView
      pointerEvents="none"
      tint="systemThinMaterial"
      intensity={props.blurIntensity ?? 50}
      style={[StyleSheet.absoluteFillObject, LEGACY_RIM_STYLE]}
    />
  );
}

/**
 * A platform material host with a separate normal-flow content layer. The
 * absolute material layer never owns layout or pointer events, so changing
 * between Liquid Glass, blur, and solid cannot move or obscure the content.
 */
export const GlassSurface = React.memo(function GlassSurface(props: GlassSurfaceProps) {
  const reduceTransparency = useReduceTransparency();
  const liquidGlassInspection = getLiquidGlassInspection();
  const blurView = getBlurViewComponent();
  const capability = getCapability(props, reduceTransparency, liquidGlassInspection, blurView);

  if (capability === 'material') {
    return (
      <MaterialSurface
        testID={props.testID}
        dynamicScheme={props.dynamicScheme}
        tone={props.materialTone}
        elevation={props.materialElevation}
        shape={props.materialShape}
        style={props.style}
      >
        {props.children}
      </MaterialSurface>
    );
  }

  const GlassView = capability === 'liquidGlass' ? getGlassViewComponent() : null;
  const useLiquidGlass = capability === 'liquidGlass' && GlassView !== null;
  const useBlur = capability === 'blur' && blurView !== null;

  return (
    <View
      testID={props.testID}
      style={[
        styles.host,
        props.style,
        Platform.OS === 'ios' && (capability === 'blur' || capability === 'solid')
          ? IOS_FALLBACK_CHROME_STYLE
          : null,
      ]}
    >
      {useLiquidGlass && renderLiquidGlass(GlassView, props)}
      {useBlur && renderBlur(blurView, props)}
      {capability === 'webBlur' && <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, getWebBlurStyle(), LEGACY_RIM_STYLE]} />}
      {!useLiquidGlass && !useBlur && capability !== 'webBlur' && (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFillObject, LEGACY_RIM_STYLE, { backgroundColor: getSolidColor(props, reduceTransparency) }]}
        />
      )}
      <View style={styles.contentLayer}>{props.children}</View>
    </View>
  );
});

const styles = StyleSheet.create({
  host: {
    position: 'relative',
    overflow: 'hidden',
  },
  contentLayer: {
    position: 'relative',
  },
});
