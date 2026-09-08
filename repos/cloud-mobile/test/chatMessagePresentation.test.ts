import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PROCESS_CONTENT_MAX_LINES,
  USER_PROMPT_MAX_LINES,
  hasLineOverflow,
  processContentMaxHeight,
  shouldShowPromptExpand,
} from '../src/features/chat/messagePresentation';

describe('chat message presentation limits', () => {
  it('keeps user prompts collapsed through the ten-line boundary', () => {
    expect(USER_PROMPT_MAX_LINES).toBe(10);
    expect(shouldShowPromptExpand(10)).toBe(false);
    expect(shouldShowPromptExpand(11)).toBe(true);
    expect(hasLineOverflow(10, USER_PROMPT_MAX_LINES)).toBe(false);
    expect(hasLineOverflow(11, USER_PROMPT_MAX_LINES)).toBe(true);
  });

  it('uses a five-line process viewport without changing the source text', () => {
    expect(PROCESS_CONTENT_MAX_LINES).toBe(5);
    expect(processContentMaxHeight(21)).toBe(105);
    expect(processContentMaxHeight(20)).toBe(100);
  });

  it('measures full prompt layout while rendering only the collapsed limit', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/features/chat/ChatScreen.tsx'), 'utf8');
    expect(source).toContain('onTextLayout={onFullTextLayout}');
    expect(source).toContain('numberOfLines={expanded ? undefined : USER_PROMPT_MAX_LINES}');
    expect(source).toContain('accessibilityState={{ expanded }}');
  });
});
