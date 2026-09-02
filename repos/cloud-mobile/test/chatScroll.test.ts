import { describe, expect, it } from 'vitest';
import { CHAT_BOTTOM_THRESHOLD_PX, atBottomFromMetrics, chatDistanceFromEnd, isChatAtBottom, shouldFollowActiveStream } from '../src/features/chat/chatScroll';
describe('chat bottom following', () => {
  it('uses a stable, forgiving bottom threshold', () => {
    expect(isChatAtBottom(1000, 400, 600 - CHAT_BOTTOM_THRESHOLD_PX)).toBe(true);
    expect(isChatAtBottom(1000, 400, 600 - CHAT_BOTTOM_THRESHOLD_PX - 1)).toBe(false);
  });
  it('treats short, non-scrollable transcripts as being at the bottom', () => {
    expect(chatDistanceFromEnd(280, 400, 0)).toBe(0);
    expect(isChatAtBottom(280, 400, 0)).toBe(true);
  });
  it('does not infer bottom before metrics, then initializes short and long histories correctly', () => {
    expect(atBottomFromMetrics({ contentHeight: 0, viewportHeight: 400, offsetY: 0 })).toBeUndefined();
    expect(atBottomFromMetrics({ contentHeight: 280, viewportHeight: 400, offsetY: 0 })).toBe(true);
    expect(atBottomFromMetrics({ contentHeight: 1000, viewportHeight: 400, offsetY: 0 })).toBe(false);
  });
  it('follows only an active stream while the reader remains at the bottom', () => {
    expect(shouldFollowActiveStream(true, true)).toBe(true);
    expect(shouldFollowActiveStream(false, true)).toBe(false);
    expect(shouldFollowActiveStream(true, false)).toBe(false);
  });
  it('continues following consecutive active content growth without a user drag', () => {
    expect([1, 2, 3].every(() => shouldFollowActiveStream(true, true))).toBe(true);
  });
});
