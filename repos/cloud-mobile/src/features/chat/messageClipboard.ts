export interface ClipboardPort {
  readonly setStringAsync: (value: string) => Promise<boolean | void>;
}

/** Copy the source string unchanged; formatting decisions belong to the renderer. */
export async function copyMessageText(
  rawText: string,
  clipboard?: ClipboardPort,
): Promise<void> {
  if (rawText.length === 0) return;
  const Clipboard = clipboard ?? await import('expo-clipboard');
  const copied = await Clipboard.setStringAsync(rawText);
  if (copied === false) throw new Error('Clipboard rejected the message');
}
