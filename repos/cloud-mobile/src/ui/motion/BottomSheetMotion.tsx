import { useCallback, useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { Modal, Platform, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

export const BOTTOM_SHEET_BACKDROP_DURATION_MS = 160;
export const BOTTOM_SHEET_EXIT_DURATION_MS = 250;
const SHEET_EASING = Easing.bezier(0.32, 0.72, 0, 1);

export interface BottomSheetMotionProps {
  readonly children: ReactNode;
  readonly reduceMotion: boolean;
  readonly onExitComplete?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}

export function BottomSheetBackdrop(props: {
  readonly onEnterComplete?: () => void;
  readonly onExitComplete?: () => void;
  readonly style?: StyleProp<ViewStyle>;
}): JSX.Element {
  const onEnterComplete = props.onEnterComplete;
  const entering = FadeIn.duration(BOTTOM_SHEET_BACKDROP_DURATION_MS);
  entering.withCallback((finished) => {
    'worklet';
    if (finished && onEnterComplete !== undefined) scheduleOnRN(onEnterComplete);
  });
  const onExitComplete = props.onExitComplete;
  const exiting = FadeOut.duration(BOTTOM_SHEET_EXIT_DURATION_MS);
  exiting.withCallback((finished) => {
    'worklet';
    if (finished && onExitComplete !== undefined) scheduleOnRN(onExitComplete);
  });
  return <Animated.View entering={entering} exiting={exiting} pointerEvents="none" style={[StyleSheet.absoluteFill, props.style]} />;
}

/**
 * Animates only the sheet content. The modal backdrop is deliberately kept
 * outside this view so it is already covering the screen before the sheet
 * rises from the bottom edge.
 */
export function BottomSheetMotion(props: BottomSheetMotionProps): JSX.Element {
  const entering = props.reduceMotion
    ? FadeIn.duration(120)
    : SlideInDown.duration(300).easing(SHEET_EASING);
  const exiting = props.reduceMotion
    ? FadeOut.duration(BOTTOM_SHEET_EXIT_DURATION_MS)
    : SlideOutDown.duration(BOTTOM_SHEET_EXIT_DURATION_MS).easing(SHEET_EASING);
  const onExitComplete = props.onExitComplete;
  exiting.withCallback((finished) => {
    'worklet';
    if (finished && onExitComplete !== undefined) scheduleOnRN(onExitComplete);
  });
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
  readonly onClose: () => void;
  /** Called after the native Modal has completed its dismissal. */
  readonly onDismiss?: () => void;
  readonly panelStyle?: StyleProp<ViewStyle>;
  readonly reduceMotion: boolean;
  readonly scrimStyle?: StyleProp<ViewStyle>;
  readonly visible: boolean;
}): JSX.Element | null {
  const [modalVisible, setModalVisible] = useState(props.visible);
  const [backdropMounted, setBackdropMounted] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);
  const [motionCycle, setMotionCycle] = useState(0);
  const latestChildren = useRef(props.children);
  const visibleRef = useRef(props.visible);
  const wasVisibleRef = useRef(false);
  const dismissalPendingRef = useRef(false);
  const panelExitPendingRef = useRef(false);
  const panelMountedRef = useRef(false);
  const mountedRef = useRef(true);
  const motionCycleRef = useRef(0);
  visibleRef.current = props.visible;
  panelMountedRef.current = panelMounted;
  motionCycleRef.current = motionCycle;
  if (props.visible) latestChildren.current = props.children;

  const advanceMotionCycle = useCallback((): void => {
    const nextCycle = motionCycleRef.current + 1;
    motionCycleRef.current = nextCycle;
    setMotionCycle(nextCycle);
  }, []);

  const startShow = useCallback((): void => {
    dismissalPendingRef.current = false;
    panelExitPendingRef.current = false;
    advanceMotionCycle();
    setModalVisible(true);
    setBackdropMounted(true);
    panelMountedRef.current = false;
    setPanelMounted(false);
  }, [advanceMotionCycle]);

  const notifyDismissed = useCallback((): void => {
    // On iOS the Modal remains mounted while `visible={false}` until this
    // callback; Android hides it after the local visible prop is committed.
    // A show requested during that interval is queued by the effect below, so
    // an old native event cannot complete a later close cycle.
    if (!dismissalPendingRef.current) return;
    dismissalPendingRef.current = false;
    if (visibleRef.current) {
      startShow();
    } else {
      setBackdropMounted(false);
      setPanelMounted(false);
    }
    props.onDismiss?.();
  }, [props.onDismiss, startShow]);

  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = props.visible;
    if (props.visible) {
      if (dismissalPendingRef.current) {
        // If native dismissal has not started yet, cancel the exit and keep
        // this same Modal owner. Once modalVisible is false, native dismissal
        // is in flight and notifyDismissed() will reopen it after completion.
        if (modalVisible) {
          dismissalPendingRef.current = false;
          panelExitPendingRef.current = false;
          advanceMotionCycle();
          setBackdropMounted(true);
          panelMountedRef.current = true;
          setPanelMounted(true);
        }
        return;
      }
      if (!wasVisible) {
        startShow();
        return;
      }
      return;
    }
    if (wasVisible) {
      dismissalPendingRef.current = true;
      panelExitPendingRef.current = panelMountedRef.current;
      setPanelMounted(false);
      setBackdropMounted(false);
    }
  }, [advanceMotionCycle, modalVisible, props.visible, startShow]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleBackdropEnterComplete = useCallback((cycle: number): void => {
    if (!mountedRef.current || !visibleRef.current || dismissalPendingRef.current || motionCycleRef.current !== cycle) return;
    panelMountedRef.current = true;
    setPanelMounted(true);
  }, []);

  const handleBackdropExitComplete = useCallback((cycle: number): void => {
    if (!mountedRef.current || visibleRef.current || !dismissalPendingRef.current || panelExitPendingRef.current || motionCycleRef.current !== cycle) return;
    setModalVisible(false);
  }, []);

  const handlePanelExitComplete = useCallback((cycle: number): void => {
    if (!mountedRef.current || visibleRef.current || !dismissalPendingRef.current || !panelExitPendingRef.current || motionCycleRef.current !== cycle) return;
    panelExitPendingRef.current = false;
    setModalVisible(false);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'ios' && !modalVisible && dismissalPendingRef.current) notifyDismissed();
  }, [modalVisible, notifyDismissed]);

  const content = props.visible ? props.children : latestChildren.current;
  return <Modal animationType="none" onDismiss={notifyDismissed} onRequestClose={props.onClose} transparent visible={modalVisible}><View style={[styles.backdrop, props.containerStyle]}>{backdropMounted ? <BottomSheetBackdrop key={`backdrop-${motionCycle}`} onEnterComplete={() => handleBackdropEnterComplete(motionCycle)} onExitComplete={() => handleBackdropExitComplete(motionCycle)} style={props.scrimStyle} /> : null}<Pressable accessibilityLabel="关闭弹窗" onPress={props.onClose} style={StyleSheet.absoluteFill} />{panelMounted ? <BottomSheetMotion key={`panel-${motionCycle}`} onExitComplete={() => handlePanelExitComplete(motionCycle)} reduceMotion={props.reduceMotion} style={props.panelStyle}>{content}</BottomSheetMotion> : null}</View></Modal>;
}

const styles = StyleSheet.create({ backdrop: { flex: 1, justifyContent: 'flex-end' } });
