export type ReduceTransparencyEventSubscription = Readonly<{
  remove: () => void;
}>;

export interface ReduceTransparencyPort {
  readonly isReduceTransparencyEnabled: () => Promise<boolean>;
  readonly addEventListener: (
    eventName: 'reduceTransparencyChanged',
    listener: (enabled: boolean) => void,
  ) => ReduceTransparencyEventSubscription;
}

export async function readReduceTransparency(port: ReduceTransparencyPort): Promise<boolean> {
  try {
    return await port.isReduceTransparencyEnabled();
  } catch {
    // An unknown accessibility state must not enable translucency by accident.
    return true;
  }
}

export function subscribeToReduceTransparency(
  port: ReduceTransparencyPort,
  listener: (enabled: boolean) => void,
): () => void {
  let subscription: ReduceTransparencyEventSubscription | undefined;
  let removed = false;
  try {
    subscription = port.addEventListener('reduceTransparencyChanged', listener);
  } catch {
    return () => undefined;
  }

  return () => {
    if (removed) {
      return;
    }
    removed = true;
    try {
      subscription?.remove();
    } catch {
      // Native teardown is best effort during unmount.
    }
  };
}
