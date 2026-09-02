/**
 * The compact title is deliberately delayed until the hero has started to
 * leave the viewport. This keeps the initial Cloud hero quiet while giving a
 * user who scrolls a clear, stable wayfinding cue.
 */
export const HOME_TITLE_REVEAL_START = 96;
export const HOME_TITLE_REVEAL_END = 168;

export function homeTitleProgress(offset: number): number {
  if (!Number.isFinite(offset) || offset <= HOME_TITLE_REVEAL_START) return 0;
  if (offset >= HOME_TITLE_REVEAL_END) return 1;
  return (offset - HOME_TITLE_REVEAL_START) / (HOME_TITLE_REVEAL_END - HOME_TITLE_REVEAL_START);
}
