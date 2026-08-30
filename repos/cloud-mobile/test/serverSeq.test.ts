import { describe, expect, it } from 'vitest';

import { decideServerSeqApply } from '../src/sync/serverSeq';

describe('serverSeq apply decision', () => {
  it('accepts forward gaps because channel filtering can create holes', () => {
    expect(decideServerSeqApply(4, 6)).toEqual({
      apply: true,
      reason: 'forward_gap',
    });
  });

  it('ignores duplicate and stale envelopes', () => {
    expect(decideServerSeqApply(4, 4)).toEqual({ apply: false, reason: 'duplicate' });
    expect(decideServerSeqApply(4, 3)).toEqual({ apply: false, reason: 'stale' });
  });
});
