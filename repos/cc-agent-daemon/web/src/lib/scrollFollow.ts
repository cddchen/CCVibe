/** Index to pin to the viewport bottom when auto-following output. Null when following is off or the list is empty. */
export function followTargetIndex(messageCount: number, followOutput: boolean): number | null {
  if (!followOutput || messageCount <= 0) return null;
  return messageCount - 1;
}
