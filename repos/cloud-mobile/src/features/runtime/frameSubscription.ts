export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/** Coalesces any number of store changes before the next display frame. */
export function subscribeOnFrame(
  subscribe: (listener: () => void) => () => void,
  onStoreChange: () => void,
  scheduler: FrameScheduler,
): () => void {
  let active = true;
  let frame: number | undefined;
  const unsubscribe = subscribe(() => {
    if (!active || frame !== undefined) return;
    frame = scheduler.request(() => {
      frame = undefined;
      if (active) onStoreChange();
    });
  });
  return () => {
    active = false;
    unsubscribe();
    if (frame !== undefined) scheduler.cancel(frame);
  };
}
