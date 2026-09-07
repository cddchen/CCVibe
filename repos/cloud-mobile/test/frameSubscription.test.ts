import { describe, expect, it } from 'vitest';

import { subscribeOnFrame, type FrameScheduler } from '../src/features/runtime/frameSubscription';

describe('frame-coalesced runtime subscription', () => {
  it('delivers a burst once on the next frame and cancels pending work on cleanup', () => {
    let storeListener: (() => void) | undefined;
    let scheduled: (() => void) | undefined;
    let unsubscribed = false;
    const cancelled: number[] = [];
    const scheduler: FrameScheduler = {
      request: (callback) => { scheduled = callback; return 7; },
      cancel: (handle) => { cancelled.push(handle); scheduled = undefined; },
    };
    let notifications = 0;
    const cleanup = subscribeOnFrame(
      (listener) => { storeListener = listener; return () => { unsubscribed = true; }; },
      () => { notifications += 1; },
      scheduler,
    );

    storeListener?.();
    storeListener?.();
    storeListener?.();
    expect(notifications).toBe(0);
    scheduled?.();
    expect(notifications).toBe(1);

    storeListener?.();
    cleanup();
    expect(unsubscribed).toBe(true);
    expect(cancelled).toEqual([7]);
    expect(notifications).toBe(1);
  });
});
