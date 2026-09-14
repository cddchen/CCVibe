import { describe, expect, it } from 'vitest';

import { shouldShowDeferredTranscriptLoading } from '../src/features/chat/chatTranscript';

describe('deferred chat transcript empty state', () => {
  it('keeps a loading empty state while deferred turns catch up with received turns', () => {
    expect(shouldShowDeferredTranscriptLoading(0, 2, undefined, false)).toBe(true);
  });

  it('keeps a truly empty idle chat on the normal empty state', () => {
    expect(shouldShowDeferredTranscriptLoading(0, 0, undefined, false)).toBe(false);
  });

  it('does not replace pending or failed states with deferred loading', () => {
    expect(shouldShowDeferredTranscriptLoading(0, 2, '2026-09-11T00:00:00.000Z', false)).toBe(false);
    expect(shouldShowDeferredTranscriptLoading(0, 2, undefined, true)).toBe(false);
  });
});
