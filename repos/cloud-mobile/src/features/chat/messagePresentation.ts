/** User prompts stay compact without changing the prompt stored by Host. */
export const USER_PROMPT_MAX_LINES = 10;

/** Process details get their own scroll viewport instead of growing the transcript. */
export const PROCESS_CONTENT_MAX_LINES = 5;

export function hasLineOverflow(lineCount: number, maxLines: number): boolean {
  return lineCount > maxLines;
}

export function shouldShowPromptExpand(lineCount: number): boolean {
  return hasLineOverflow(lineCount, USER_PROMPT_MAX_LINES);
}

export function processContentMaxHeight(lineHeight: number): number {
  return lineHeight * PROCESS_CONTENT_MAX_LINES;
}
