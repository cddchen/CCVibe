import * as React from 'react';
import { Platform, View, type ColorValue, type StyleProp, type ViewStyle } from 'react-native';

import {
  GlassSurface,
  type GlassSurfaceProps,
} from './GlassSurface';

const DEFAULT_RADIUS = 24;
const DEFAULT_BLUR_INTENSITY = 58;

export type GlassPanelProps = Readonly<{
  children?: React.ReactNode;
  radius?: number;
  containerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  maxWidth?: number;
  blurIntensity?: number;
  glassEffectStyle?: GlassSurfaceProps['glassEffectStyle'];
  interactive?: boolean;
  forceSolid?: boolean;
  solidColor?: ColorValue;
  materialTone?: GlassSurfaceProps['materialTone'];
  materialElevation?: GlassSurfaceProps['materialElevation'];
  materialShape?: GlassSurfaceProps['materialShape'];
  dynamicScheme?: GlassSurfaceProps['dynamicScheme'];
  testID?: string;
}>;

const IOS_CAST_SHADOW: ViewStyle = Object.freeze({
  shadowColor: '#000000',
  shadowOpacity: 0.12,
  shadowRadius: 8,
  shadowOffset: { width: 0, height: 2 },
});

/**
 * Shared floating chrome wrapper. iOS legacy blur receives a light cast
 * shadow outside the clipped material host; Android delegates the surface to
 * Material 3 and never renders an Apple glass or blur layer.
 */
export const GlassPanel = React.memo(function GlassPanel(props: GlassPanelProps) {
  const radius = props.radius ?? DEFAULT_RADIUS;
  const outerStyle: StyleProp<ViewStyle> = [
    { borderRadius: radius, flexShrink: 1, minHeight: 0 },
    props.maxWidth === undefined ? null : { maxWidth: props.maxWidth },
    Platform.OS === 'ios' ? IOS_CAST_SHADOW : null,
    props.containerStyle,
  ];

  return (
    <View style={outerStyle}>
      <GlassSurface
        testID={props.testID}
        enabled={props.forceSolid !== true}
        blurIntensity={props.blurIntensity ?? DEFAULT_BLUR_INTENSITY}
        glassEffectStyle={props.glassEffectStyle}
        interactive={props.interactive}
        solidColor={props.solidColor}
        materialTone={props.materialTone}
        materialElevation={props.materialElevation}
        materialShape={props.materialShape}
        dynamicScheme={props.dynamicScheme}
        style={[{ borderRadius: radius }, props.style]}
      >
        {props.children}
      </GlassSurface>
    </View>
  );
});
