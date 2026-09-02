import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';

export const BOTTOM_SHEET_BACKDROP_DURATION_MS = 160;
export const BOTTOM_SHEET_EXIT_DURATION_MS = 250;
const MODAL_UNMOUNT_GRACE_MS = 16;
export const BOTTOM_SHEET_DISMISS_MS = BOTTOM_SHEET_EXIT_DURATION_MS + MODAL_UNMOUNT_GRACE_MS;
const DEFAULT_SHEET_ENTER_DELAY_MS = 60;
const SHEET_EASING = Easing.bezier(0.32, 0.72, 0, 1);

export interface BottomSheetMotionProps {
  readonly children: ReactNode;
  readonly reduceMotion: boolean;
  /** Delay the panel until a separately mounted backdrop has appeared. */
  readonly enterDelayMs?: number;
  readonly style?: StyleProp<ViewStyle>;
}

export function BottomSheetBackdrop(props: { readonly style?: StyleProp<ViewStyle> }): JSX.Element {
  return <Animated.View entering={FadeIn.duration(BOTTOM_SHEET_BACKDROP_DURATION_MS)} exiting={FadeOut.duration(BOTTOM_SHEET_EXIT_DURATION_MS)} pointerEvents="none" style={[StyleSheet.absoluteFill, props.style]} />;
}

/**
 * Animates only the sheet content. The modal backdrop is deliberately kept
 * outside this view so it is already covering the screen before the sheet
 * rises from the bottom edge.
 */
export function BottomSheetMotion(props: BottomSheetMotionProps): JSX.Element {
  const enterDelayMs = props.enterDelayMs ?? (props.reduceMotion ? 0 : DEFAULT_SHEET_ENTER_DELAY_MS);
  const entering = props.reduceMotion
    ? FadeIn.duration(120).delay(enterDelayMs)
    : SlideInDown.duration(300).delay(enterDelayMs).easing(SHEET_EASING);
  const exiting = props.reduceMotion
    ? FadeOut.duration(BOTTOM_SHEET_EXIT_DURATION_MS)
    : SlideOutDown.duration(BOTTOM_SHEET_EXIT_DURATION_MS).easing(SHEET_EASING);
  return (
    <Animated.View
      entering={entering}
      exiting={exiting}
      style={props.style}
    >
      {props.children}
    </Animated.View>
  );
}

/** Keeps the native Modal alive until panel and scrim have completed their exit. */
export function BottomSheetFrame(props: {
  readonly children: ReactNode;
  readonly containerStyle?: StyleProp<ViewStyle>;
  readonly enterDelayMs?: number;
  readonly onClose: () => void;
  readonly panelStyle?: StyleProp<ViewStyle>;
  readonly reduceMotion: boolean;
  readonly scrimStyle?: StyleProp<ViewStyle>;
  readonly visible: boolean;
}): JSX.Element | null {
  const [modalMounted, setModalMounted] = useState(props.visible);
  const [panelMounted, setPanelMounted] = useState(props.visible);
  const latestChildren = useRef(props.children);
  const visibleRef = useRef(props.visible);
  visibleRef.current = props.visible;
  // This is a normal React ref (not an animated shared value); retain the
  // last rendered tree so a controlled close cannot blank its exit frame.
  if (props.visible) latestChildren.current = props.children;
  useEffect(() => {
    if (props.visible) {
      setModalMounted(true);
      setPanelMounted(true);
      return;
    }
    setPanelMounted(false);
    const timer = setTimeout(() => { if (!visibleRef.current) setModalMounted(false); }, BOTTOM_SHEET_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [props.visible]);
  if (!modalMounted) return null;
  const content = props.visible ? props.children : latestChildren.current;
  return <Modal animationType="none" onRequestClose={props.onClose} transparent visible><View style={[styles.backdrop, props.containerStyle]}>{panelMounted ? <BottomSheetBackdrop style={props.scrimStyle} /> : null}<Pressable accessibilityLabel="关闭弹窗" onPress={props.onClose} style={StyleSheet.absoluteFill} />{panelMounted ? <BottomSheetMotion enterDelayMs={props.reduceMotion ? 0 : (props.enterDelayMs ?? BOTTOM_SHEET_BACKDROP_DURATION_MS)} reduceMotion={props.reduceMotion} style={props.panelStyle}>{content}</BottomSheetMotion> : null}</View></Modal>;
}

const styles = StyleSheet.create({ backdrop: { flex: 1, justifyContent: 'flex-end' } });
