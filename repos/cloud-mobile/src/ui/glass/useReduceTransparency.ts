import * as React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

import {
  readReduceTransparency,
  subscribeToReduceTransparency,
} from './reduceTransparency';
import type { ReduceTransparencyPort } from './reduceTransparency';

export type {
  ReduceTransparencyEventSubscription,
  ReduceTransparencyPort,
} from './reduceTransparency';
export {
  readReduceTransparency,
  subscribeToReduceTransparency,
} from './reduceTransparency';

const accessibilityPort: ReduceTransparencyPort = AccessibilityInfo;

/**
 * Runtime Reduce Transparency state. The native query seeds the value and the
 * iOS event keeps already-mounted surfaces in sync with Settings changes.
 */
export function useReduceTransparency(): boolean {
  // iOS starts opaque until the asynchronous accessibility query confirms
  // that translucency is allowed, avoiding a transparent first frame.
  const [enabled, setEnabled] = React.useState(Platform.OS === 'ios');

  React.useEffect(() => {
    if (Platform.OS !== 'ios') {
      setEnabled(false);
      return undefined;
    }

    let active = true;
    let eventReceived = false;
    const cleanup = subscribeToReduceTransparency(accessibilityPort, (nextValue) => {
      eventReceived = true;
      if (active) {
        setEnabled(nextValue);
      }
    });

    void readReduceTransparency(accessibilityPort).then((initialValue) => {
      if (active && !eventReceived) {
        setEnabled(initialValue);
      }
    });

    return () => {
      active = false;
      cleanup();
    };
  }, []);

  return enabled;
}
