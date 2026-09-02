export interface MeasuredComposerFrame {
  readonly pageY: number;
  readonly height: number;
}

/**
 * Returns the minimum translation needed to keep the composer bottom at or
 * above the current keyboard top. Keyboard-controller exposes its shared
 * height as a negative value while the keyboard is visible.
 */
export function composerKeyboardTranslation(
  frame: MeasuredComposerFrame | null,
  windowHeight: number,
  keyboardHeight: number,
): number {
  'worklet';

  const visibleKeyboardHeight = Math.max(-keyboardHeight, 0);
  if (frame === null || visibleKeyboardHeight === 0) return 0;

  const keyboardTop = windowHeight - visibleKeyboardHeight;
  const overlap = Math.max(frame.pageY + frame.height - keyboardTop, 0);
  return overlap === 0 ? 0 : -overlap;
}
