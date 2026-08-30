import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';

import {
  createMaterialTokens,
  getMaterialSurfaceStyle,
  type MaterialDynamicScheme,
  type MaterialElevation,
  type MaterialSemanticTokens,
  type MaterialShape,
  type MaterialSurfaceStyleOptions,
  type MaterialSurfaceTone,
} from './materialTokens';

export type MaterialSurfaceProps = Readonly<{
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  theme?: MD3Theme;
  dynamicScheme?: MaterialDynamicScheme;
  tone?: MaterialSurfaceTone;
  elevation?: MaterialElevation;
  shape?: MaterialShape;
  testID?: string;
  pointerEvents?: 'box-none' | 'none' | 'box-only' | 'auto';
}>;

export function materialSurfaceStyle(
  tokens: MaterialSemanticTokens,
  options?: MaterialSurfaceStyleOptions,
): ViewStyle {
  return getMaterialSurfaceStyle(tokens, options);
}

export const MaterialSurface = React.memo(function MaterialSurface(props: MaterialSurfaceProps) {
  const paperTheme = useTheme<MD3Theme>();
  const tokens = createMaterialTokens(props.theme ?? paperTheme, props.dynamicScheme);
  const surfaceStyle = materialSurfaceStyle(tokens, {
    tone: props.tone,
    elevation: props.elevation,
    shape: props.shape,
  });

  return (
    <View
      testID={props.testID}
      pointerEvents={props.pointerEvents}
      style={[surfaceStyle, props.style]}
    >
      {props.children}
    </View>
  );
});
