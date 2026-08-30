import { describe, expect, it } from 'vitest';

import {
  readReduceTransparency,
  subscribeToReduceTransparency,
  type ReduceTransparencyPort,
} from '../src/ui/glass/reduceTransparency';

function createPort(initialValue: boolean): {
  readonly port: ReduceTransparencyPort;
  readonly emit: (value: boolean) => void;
  readonly getRemovedCount: () => number;
} {
  let listener: ((enabled: boolean) => void) | undefined;
  let removedCount = 0;
  return {
    port: {
      isReduceTransparencyEnabled: async () => initialValue,
      addEventListener: (_eventName, nextListener) => {
        listener = nextListener;
        return {
          remove: () => {
            removedCount += 1;
            listener = undefined;
          },
        };
      },
    },
    emit: (value) => listener?.(value),
    getRemovedCount: () => removedCount,
  };
}

describe('Reduce Transparency runtime seam', () => {
  it('reads the current setting and fails closed to opaque material when the native query rejects', async () => {
    const enabled = createPort(true);
    await expect(readReduceTransparency(enabled.port)).resolves.toBe(true);

    const failingPort: ReduceTransparencyPort = {
      isReduceTransparencyEnabled: async () => {
        throw new Error('accessibility bridge unavailable');
      },
      addEventListener: () => ({ remove: () => undefined }),
    };
    await expect(readReduceTransparency(failingPort)).resolves.toBe(true);
  });

  it('subscribes to changes and removes the listener on cleanup', () => {
    const harness = createPort(false);
    const values: boolean[] = [];
    const cleanup = subscribeToReduceTransparency(harness.port, (value) => values.push(value));

    harness.emit(true);
    harness.emit(false);
    expect(values).toEqual([true, false]);

    cleanup();
    cleanup();
    expect(harness.getRemovedCount()).toBe(1);
    harness.emit(true);
    expect(values).toEqual([true, false]);
  });

  it('keeps cleanup safe when event registration throws', () => {
    const port: ReduceTransparencyPort = {
      isReduceTransparencyEnabled: async () => false,
      addEventListener: () => {
        throw new Error('event bridge unavailable');
      },
    };

    expect(() => subscribeToReduceTransparency(port, () => undefined)).not.toThrow();
  });
});
