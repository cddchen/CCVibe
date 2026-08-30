import { describe, expect, it } from 'vitest';

import { createTurnStartedAction } from '../src/domain/runtimeBoundary';

describe('runtime dependency boundary', () => {
  it('uses injected time and id providers when creating actions', () => {
    const action = createTurnStartedAction(
      {
        now: () => '2026-08-29T00:00:00.000Z',
        createId: () => 'turn-1',
        platform: 'ios',
      },
      'hello',
    );

    expect(action).toEqual({
      type: 'chat/turnStarted',
      turnId: 'turn-1',
      prompt: 'hello',
      timestamp: '2026-08-29T00:00:00.000Z',
    });
  });
});
