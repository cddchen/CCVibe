import type { MD3Theme } from 'react-native-paper';
import type { ViewStyle } from 'react-native';

export type MaterialElevation = 0 | 1 | 2 | 3 | 4 | 5;
export type MaterialShape =
  | 'none'
  | 'extraSmall'
  | 'small'
  | 'medium'
  | 'large'
  | 'extraLarge'
  | 'full';

export type MaterialSurfaceTone =
  | 'surface'
  | 'surfaceContainerLowest'
  | 'surfaceContainerLow'
  | 'surfaceContainer'
  | 'surfaceContainerHigh'
  | 'surfaceContainerHighest';

type PaperMD3Colors = MD3Theme['colors'];

export type MaterialDynamicScheme = Readonly<Partial<PaperMD3Colors> & {
  readonly surfaceContainerLowest?: string;
  readonly surfaceContainerLow?: string;
  readonly surfaceContainer?: string;
  readonly surfaceContainerHigh?: string;
  readonly surfaceContainerHighest?: string;
}>;

export interface MaterialSemanticColors {
  readonly primary: string;
  readonly onPrimary: string;
  readonly primaryContainer: string;
  readonly onPrimaryContainer: string;
  readonly secondary: string;
  readonly onSecondary: string;
  readonly secondaryContainer: string;
  readonly onSecondaryContainer: string;
  readonly tertiary: string;
  readonly onTertiary: string;
  readonly tertiaryContainer: string;
  readonly onTertiaryContainer: string;
  readonly surface: string;
  readonly surfaceContainerLowest: string;
  readonly surfaceContainerLow: string;
  readonly surfaceContainer: string;
  readonly surfaceContainerHigh: string;
  readonly surfaceContainerHighest: string;
  readonly onSurface: string;
  readonly onSurfaceVariant: string;
  readonly outline: string;
  readonly outlineVariant: string;
  readonly background: string;
  readonly onBackground: string;
  readonly error: string;
  readonly onError: string;
  readonly errorContainer: string;
  readonly onErrorContainer: string;
  readonly shadow: string;
  readonly scrim: string;
}

export interface MaterialSemanticTokens extends MaterialSemanticColors {
  readonly colors: MaterialSemanticColors;
  readonly shape: Readonly<Record<MaterialShape, number>>;
  readonly elevation: Readonly<Record<MaterialElevation, number>>;
}

export interface MaterialSurfaceStyleOptions {
  readonly tone?: MaterialSurfaceTone;
  readonly elevation?: MaterialElevation;
  readonly shape?: MaterialShape;
}

type MaterialColorKey = keyof PaperMD3Colors;

function colorFrom(
  scheme: MaterialDynamicScheme & Partial<PaperMD3Colors>,
  key: MaterialColorKey,
  fallback: string,
): string {
  const candidate = scheme[key];
  return typeof candidate === 'string' ? candidate : fallback;
}

function optionalColorFrom(
  scheme: MaterialDynamicScheme,
  key: keyof MaterialDynamicScheme,
): string | undefined {
  const candidate = scheme[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

export function createMaterialTokens(
  theme: MD3Theme,
  dynamicScheme: MaterialDynamicScheme = {},
): MaterialSemanticTokens {
  const scheme = { ...theme.colors, ...dynamicScheme };
  const surface = colorFrom(scheme, 'surface', theme.colors.surface);
  const surfaceVariant = colorFrom(scheme, 'surfaceVariant', theme.colors.surfaceVariant);
  const colors: MaterialSemanticColors = Object.freeze({
    primary: colorFrom(scheme, 'primary', theme.colors.primary),
    onPrimary: colorFrom(scheme, 'onPrimary', theme.colors.onPrimary),
    primaryContainer: colorFrom(scheme, 'primaryContainer', theme.colors.primaryContainer),
    onPrimaryContainer: colorFrom(scheme, 'onPrimaryContainer', theme.colors.onPrimaryContainer),
    secondary: colorFrom(scheme, 'secondary', theme.colors.secondary),
    onSecondary: colorFrom(scheme, 'onSecondary', theme.colors.onSecondary),
    secondaryContainer: colorFrom(scheme, 'secondaryContainer', theme.colors.secondaryContainer),
    onSecondaryContainer: colorFrom(scheme, 'onSecondaryContainer', theme.colors.onSecondaryContainer),
    tertiary: colorFrom(scheme, 'tertiary', theme.colors.tertiary),
    onTertiary: colorFrom(scheme, 'onTertiary', theme.colors.onTertiary),
    tertiaryContainer: colorFrom(scheme, 'tertiaryContainer', theme.colors.tertiaryContainer),
    onTertiaryContainer: colorFrom(scheme, 'onTertiaryContainer', theme.colors.onTertiaryContainer),
    surface,
    surfaceContainerLowest: optionalColorFrom(scheme, 'surfaceContainerLowest') ?? surface,
    surfaceContainerLow: optionalColorFrom(scheme, 'surfaceContainerLow') ?? surface,
    surfaceContainer: optionalColorFrom(scheme, 'surfaceContainer') ?? surface,
    surfaceContainerHigh: optionalColorFrom(scheme, 'surfaceContainerHigh') ?? surfaceVariant,
    surfaceContainerHighest: optionalColorFrom(scheme, 'surfaceContainerHighest') ?? surfaceVariant,
    onSurface: colorFrom(scheme, 'onSurface', theme.colors.onSurface),
    onSurfaceVariant: colorFrom(scheme, 'onSurfaceVariant', theme.colors.onSurfaceVariant),
    outline: colorFrom(scheme, 'outline', theme.colors.outline),
    outlineVariant: colorFrom(scheme, 'outlineVariant', theme.colors.outlineVariant),
    background: colorFrom(scheme, 'background', theme.colors.background),
    onBackground: colorFrom(scheme, 'onBackground', theme.colors.onBackground),
    error: colorFrom(scheme, 'error', theme.colors.error),
    onError: colorFrom(scheme, 'onError', theme.colors.onError),
    errorContainer: colorFrom(scheme, 'errorContainer', theme.colors.errorContainer),
    onErrorContainer: colorFrom(scheme, 'onErrorContainer', theme.colors.onErrorContainer),
    shadow: colorFrom(scheme, 'shadow', theme.colors.shadow),
    scrim: colorFrom(scheme, 'scrim', theme.colors.scrim),
  });

  return Object.freeze({
    ...colors,
    colors,
    shape: Object.freeze({
      none: 0,
      extraSmall: 4,
      small: 8,
      medium: 12,
      large: 16,
      extraLarge: 28,
      full: 9999,
    }),
    elevation: Object.freeze({
      0: 0,
      1: 1,
      2: 3,
      3: 6,
      4: 8,
      5: 12,
    }),
  });
}

export function getMaterialSurfaceStyle(
  tokens: MaterialSemanticTokens,
  options: MaterialSurfaceStyleOptions = {},
): ViewStyle {
  const tone = options.tone ?? 'surfaceContainer';
  const elevation = options.elevation ?? 0;
  const shape = options.shape ?? 'medium';
  const elevationDp = tokens.elevation[elevation];

  return {
    backgroundColor: tokens[ tone ],
    borderRadius: tokens.shape[shape],
    elevation: elevationDp,
    shadowColor: tokens.shadow,
    shadowOpacity: elevationDp === 0 ? 0 : 0.18,
    shadowRadius: elevationDp === 0 ? 0 : Math.max(1, elevationDp / 2),
    shadowOffset: { width: 0, height: elevationDp === 0 ? 0 : Math.max(1, elevationDp / 3) },
  };
}
