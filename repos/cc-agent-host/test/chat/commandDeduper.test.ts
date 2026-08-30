import { describe, expect, it } from 'vitest';

import {
  CommandDeduper,
  createClientId,
  createCommandId,
  type CommandKey,
} from '../../src/index.js';

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const clientA = createClientId('client-a');
const clientB = createClientId('client-b');
const commandOne = createCommandId('command-one');
const commandTwo = createCommandId('command-two');
const commandThree = createCommandId('command-three');

const keyA1: CommandKey = { clientId: clientA, commandId: commandOne };
const keyA2: CommandKey = { clientId: clientA, commandId: commandTwo };
const keyB1: CommandKey = { clientId: clientB, commandId: commandOne };
const keyB2: CommandKey = { clientId: clientB, commandId: commandTwo };
const keyA3: CommandKey = { clientId: clientA, commandId: commandThree };

const acceptedOnly = () => ({ code: 'UNEXPECTED', message: 'effect should not reject' });

class InvalidAcceptedClass {
  public readonly value = 'class instance';
}

const cyclicObject: Record<string, unknown> = {};
cyclicObject.self = cyclicObject;

const cyclicArray: unknown[] = [];
cyclicArray.push(cyclicArray);

const invalidAcceptedValues: ReadonlyArray<readonly [string, unknown]> = [
  ['undefined', undefined],
  ['NaN', Number.NaN],
  ['positive infinity', Number.POSITIVE_INFINITY],
  ['negative infinity', Number.NEGATIVE_INFINITY],
  ['bigint', 1n],
  ['function', () => 'not JSON'],
  ['symbol', Symbol('not JSON')],
  ['object cycle', cyclicObject],
  ['array cycle', cyclicArray],
  ['Date', new Date(0)],
  ['Map', new Map([['key', 'value']])],
  ['Set', new Set(['value'])],
  ['class instance', new InvalidAcceptedClass()],
  ['symbol-keyed object', { [Symbol('key')]: 'value' }],
  ['sparse array', [, 'value']],
  [
    'accessor property',
    Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => 'value',
    }),
  ],
];

describe('CommandDeduper', () => {
  it('shares one in-flight Promise and one canonical accepted receipt', async () => {
    const deduper = new CommandDeduper({ capacity: 4 });
    const gate = deferred<void>();
    let effectCalls = 0;

    const first = deduper.execute(
      keyA1,
      async () => {
        effectCalls += 1;
        await gate.promise;
        return { answer: 42 };
      },
      acceptedOnly,
    );
    const second = deduper.execute(
      keyA1,
      () => {
        effectCalls += 1;
        return { answer: 99 };
      },
      acceptedOnly,
    );

    expect(second).toBe(first);
    gate.resolve(undefined);

    const firstReceipt = await first;
    const secondReceipt = await second;
    expect(firstReceipt).toBe(secondReceipt);
    expect(firstReceipt).toEqual({ status: 'accepted', value: { answer: 42 } });
    expect(Object.isFrozen(firstReceipt)).toBe(true);
    expect(JSON.stringify(firstReceipt)).toBe('{"status":"accepted","value":{"answer":42}}');
    expect(effectCalls).toBe(1);

    const retry = await deduper.execute(keyA1, () => {
      effectCalls += 1;
      return 'should-not-run';
    }, acceptedOnly);
    expect(retry).toBe(firstReceipt);
    expect(effectCalls).toBe(1);
  });

  it.each([
    ['null', null],
    ['string', 'text'],
    ['boolean', true],
    ['finite number', -12.5],
    ['empty array', []],
    ['nested array', [null, 'text', false, 0, { nested: ['value'] }]],
    ['plain object', { nested: { answer: 42 } }],
    ['null-prototype object', Object.assign(Object.create(null), { answer: 42 })],
  ] as const)('accepts supported JSON value: %s', async (_label, value) => {
    const deduper = new CommandDeduper({ capacity: 4 });

    const receipt = await deduper.execute(keyA1, () => value, acceptedOnly);

    expect(receipt).toEqual({ status: 'accepted', value });
    expect(Object.isFrozen(receipt)).toBe(true);
    if (receipt.status === 'accepted' && typeof receipt.value === 'object' && receipt.value !== null) {
      expect(Object.isFrozen(receipt.value)).toBe(true);
    }
  });

  it('deeply clones accepted values and freezes every returned structure', async () => {
    const deduper = new CommandDeduper({ capacity: 4 });
    const original = {
      nested: {
        list: [{ count: 1 }],
        flags: [true, false],
      },
    };

    const receipt = await deduper.execute(keyA1, () => original, acceptedOnly);
    if (receipt.status !== 'accepted') {
      throw new Error('expected an accepted receipt');
    }

    const snapshot = receipt.value;
    expect(snapshot).toEqual({
      nested: {
        list: [{ count: 1 }],
        flags: [true, false],
      },
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.nested)).toBe(true);
    expect(Object.isFrozen(snapshot.nested.list)).toBe(true);
    expect(Object.isFrozen(snapshot.nested.list[0])).toBe(true);
    expect(Object.isFrozen(snapshot.nested.flags)).toBe(true);

    const originalFirst = original.nested.list[0];
    if (originalFirst === undefined) {
      throw new Error('expected original list element');
    }
    originalFirst.count = 99;
    original.nested.flags.push(true);
    expect(snapshot).toEqual({
      nested: {
        list: [{ count: 1 }],
        flags: [true, false],
      },
    });

    const mutableView = snapshot as unknown as {
      nested: { list: Array<{ count: number }>; flags: boolean[] };
    };
    expect(() => {
      const mutableFirst = mutableView.nested.list[0];
      if (mutableFirst === undefined) {
        throw new Error('expected snapshot list element');
      }
      mutableFirst.count = 2;
    }).toThrow(TypeError);
    expect(() => {
      mutableView.nested.flags.push(false);
    }).toThrow(TypeError);

    const cached = await deduper.execute(keyA1, () => {
      throw new Error('cached snapshot must not execute');
    }, acceptedOnly);
    expect(cached).toBe(receipt);
  });

  it.each(invalidAcceptedValues)('rejects unsupported accepted value: %s', async (_label, value) => {
    const deduper = new CommandDeduper({ capacity: 4 });

    await expect(deduper.execute(keyA1, () => value, acceptedOnly)).rejects.toThrow(TypeError);
    await expect(deduper.execute(keyA1, () => ({ nested: value }), acceptedOnly)).rejects.toThrow(TypeError);
  });

  it('shares canonicalization failure and retries after removing the in-flight entry', async () => {
    const deduper = new CommandDeduper({ capacity: 4 });
    const gate = deferred<void>();
    const invalidValue = { nested: undefined };
    let effectCalls = 0;

    const first = deduper.execute(
      keyA1,
      async () => {
        effectCalls += 1;
        await gate.promise;
        return invalidValue;
      },
      acceptedOnly,
    );
    const second = deduper.execute(
      keyA1,
      () => {
        effectCalls += 1;
        return 'duplicate-must-not-run';
      },
      acceptedOnly,
    );

    expect(second).toBe(first);
    gate.resolve(undefined);

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult.status).toBe('rejected');
    expect(secondResult.status).toBe('rejected');
    if (firstResult.status !== 'rejected' || secondResult.status !== 'rejected') {
      throw new Error('expected shared canonicalization rejection');
    }
    expect(firstResult.reason).toBe(secondResult.reason);
    expect(firstResult.reason).toBeInstanceOf(TypeError);
    expect(effectCalls).toBe(1);

    const retry = await deduper.execute(keyA1, () => {
      effectCalls += 1;
      return { retried: true };
    }, acceptedOnly);
    expect(retry).toEqual({ status: 'accepted', value: { retried: true } });
    expect(effectCalls).toBe(2);
  });

  it('snapshots command identity before an in-flight effect can observe key mutation', async () => {
    const deduper = new CommandDeduper({ capacity: 4 });
    const gate = deferred<void>();
    const mutableKey: { clientId: CommandKey['clientId']; commandId: CommandKey['commandId'] } = {
      clientId: clientA,
      commandId: commandOne,
    };
    let effectCalls = 0;

    const first = deduper.execute(
      mutableKey,
      async () => {
        effectCalls += 1;
        await gate.promise;
        return 'original';
      },
      acceptedOnly,
    );
    const duplicate = deduper.execute(
      keyA1,
      () => {
        effectCalls += 1;
        return 'duplicate-must-not-run';
      },
      acceptedOnly,
    );
    expect(duplicate).toBe(first);

    mutableKey.clientId = clientB;
    mutableKey.commandId = commandTwo;
    gate.resolve(undefined);

    const firstReceipt = await first;
    const originalRetry = deduper.execute(
      keyA1,
      () => {
        effectCalls += 1;
        return 'original-retry-must-not-run';
      },
      acceptedOnly,
    );
    expect(originalRetry).not.toBe(first);
    expect(await originalRetry).toBe(firstReceipt);

    const mutatedPairReceipt = await deduper.execute(
      { clientId: clientB, commandId: commandTwo },
      () => {
        effectCalls += 1;
        return 'mutated-pair';
      },
      acceptedOnly,
    );
    expect(mutatedPairReceipt).toEqual({ status: 'accepted', value: 'mutated-pair' });
    expect(effectCalls).toBe(2);
  });

  it('scopes deduplication by both client and command identity', async () => {
    const deduper = new CommandDeduper({ capacity: 4 });
    let clientACalls = 0;
    let clientBCalls = 0;

    const first = deduper.execute(keyA1, () => {
      clientACalls += 1;
      return 'client-a';
    }, acceptedOnly);
    const second = deduper.execute(keyB1, () => {
      clientBCalls += 1;
      return 'client-b';
    }, acceptedOnly);

    expect(await first).toEqual({ status: 'accepted', value: 'client-a' });
    expect(await second).toEqual({ status: 'accepted', value: 'client-b' });
    expect(clientACalls).toBe(1);
    expect(clientBCalls).toBe(1);
  });

  it('uses the first call effect and rejection mapper for a shared flight', async () => {
    const deduper = new CommandDeduper({ capacity: 4 });
    const gate = deferred<void>();
    const effectError = new Error('first effect failed');
    let effectCalls = 0;
    let firstMapperCalls = 0;
    let secondMapperCalls = 0;

    const first = deduper.execute(
      keyA3,
      async () => {
        effectCalls += 1;
        await gate.promise;
        throw effectError;
      },
      (error) => {
        firstMapperCalls += 1;
        expect(error).toBe(effectError);
        return { code: 'FIRST_ERROR', message: 'first mapper' };
      },
    );
    const second = deduper.execute(
      keyA3,
      () => {
        effectCalls += 1;
        return 'second effect must not run';
      },
      () => {
        secondMapperCalls += 1;
        return { code: 'SECOND_ERROR', message: 'second mapper' };
      },
    );

    expect(second).toBe(first);
    gate.resolve(undefined);

    await expect(first).resolves.toEqual({ status: 'rejected', code: 'FIRST_ERROR', message: 'first mapper' });
    expect(effectCalls).toBe(1);
    expect(firstMapperCalls).toBe(1);
    expect(secondMapperCalls).toBe(0);
  });

  it('maps synchronous throws and rejected Promises to canonical cached receipts', async () => {
    const deduper = new CommandDeduper({ capacity: 4 });
    const syncError = new Error('sync failure');
    const asyncError = new Error('async failure');
    const mappedErrors: unknown[] = [];

    const syncReceipt = await deduper.execute(
      keyA1,
      () => {
        throw syncError;
      },
      (error) => {
        mappedErrors.push(error);
        return { code: 'SYNC_FAILED', message: 'sync failure' };
      },
    );
    expect(syncReceipt).toEqual({ status: 'rejected', code: 'SYNC_FAILED', message: 'sync failure' });
    expect(Object.isFrozen(syncReceipt)).toBe(true);
    expect(JSON.stringify(syncReceipt)).toBe(
      '{"status":"rejected","code":"SYNC_FAILED","message":"sync failure"}',
    );
    expect(mappedErrors[0]).toBe(syncError);

    const asyncReceipt = await deduper.execute(
      keyA2,
      () => Promise.reject(asyncError),
      (error) => {
        mappedErrors.push(error);
        return { status: 'rejected' as const, code: 'ASYNC_FAILED', message: 'async failure' };
      },
    );
    expect(asyncReceipt).toEqual({ status: 'rejected', code: 'ASYNC_FAILED', message: 'async failure' });
    expect(mappedErrors[1]).toBe(asyncError);

    const retry = await deduper.execute(
      keyA2,
      () => 'should-not-run',
      () => {
        throw new Error('cached rejection must not remap');
      },
    );
    expect(retry).toBe(asyncReceipt);
    expect(JSON.stringify(retry)).toBe(
      '{"status":"rejected","code":"ASYNC_FAILED","message":"async failure"}',
    );
  });

  it('does not cache a mapper failure and does not retain its raw Error', async () => {
    const deduper = new CommandDeduper({ capacity: 4 });
    const effectError = new Error('effect error');
    const mapperError = new Error('mapper error');

    const failed = deduper.execute(
      keyA1,
      () => {
        throw effectError;
      },
      () => {
        throw mapperError;
      },
    );
    await expect(failed).rejects.toBe(mapperError);

    const retry = await deduper.execute(keyA1, () => 'ran-after-mapper-failure', acceptedOnly);
    expect(retry).toEqual({ status: 'accepted', value: 'ran-after-mapper-failure' });
  });

  it('keeps all in-flight entries when completed receipts overflow', async () => {
    const deduper = new CommandDeduper({ capacity: 1 });
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const inFlightKeys = [keyA1, keyA2, keyB1];
    let inFlightCalls = 0;

    const inFlight = inFlightKeys.map((key, index) => {
      const gate = gates[index];
      if (gate === undefined) {
        throw new Error('missing test gate');
      }
      return deduper.execute(
        key,
        async () => {
          inFlightCalls += 1;
          await gate.promise;
          return `in-flight-${index}`;
        },
        acceptedOnly,
      );
    });

    // These completions overflow the one-entry completed cache while the
    // three commands above are still waiting.
    await deduper.execute(keyB2, () => 'completed-b', acceptedOnly);
    await deduper.execute(keyA3, () => 'completed-a', acceptedOnly);

    const duplicates = inFlightKeys.map((key) =>
      deduper.execute(
        key,
        () => {
          inFlightCalls += 1;
          return 'duplicate-must-not-run';
        },
        acceptedOnly,
      ),
    );
    expect(duplicates).toEqual(inFlight);
    expect(inFlightCalls).toBe(3);

    gates.forEach((gate) => gate.resolve(undefined));
    await expect(Promise.all(duplicates)).resolves.toEqual([
      { status: 'accepted', value: 'in-flight-0' },
      { status: 'accepted', value: 'in-flight-1' },
      { status: 'accepted', value: 'in-flight-2' },
    ]);
  });

  it('uses capacity zero for single-flight only and then allows re-execution', async () => {
    const deduper = new CommandDeduper({ capacity: 0 });
    const gate = deferred<void>();
    let calls = 0;

    const first = deduper.execute(
      keyA1,
      async () => {
        calls += 1;
        await gate.promise;
        return calls;
      },
      acceptedOnly,
    );
    const duplicate = deduper.execute(keyA1, () => {
      calls += 1;
      return calls;
    }, acceptedOnly);
    expect(duplicate).toBe(first);

    gate.resolve(undefined);
    expect(await first).toEqual({ status: 'accepted', value: 1 });
    expect(await deduper.execute(keyA1, () => {
      calls += 1;
      return calls;
    }, acceptedOnly)).toEqual({ status: 'accepted', value: 2 });
    expect(calls).toBe(2);
  });

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'rejects invalid capacity %s',
    (capacity) => {
      expect(() => new CommandDeduper({ capacity })).toThrow(RangeError);
    },
  );

  it('evicts completed receipts in insertion order without refreshing cache hits', async () => {
    const deduper = new CommandDeduper({ capacity: 2 });
    const calls = new Map<string, number>();

    const execute = (key: CommandKey, label: string) =>
      deduper.execute(key, () => {
        const next = (calls.get(label) ?? 0) + 1;
        calls.set(label, next);
        return `${label}-${next}`;
      }, acceptedOnly);

    expect(await execute(keyA1, 'a')).toEqual({ status: 'accepted', value: 'a-1' });
    expect(await execute(keyB1, 'b')).toEqual({ status: 'accepted', value: 'b-1' });

    // A cache hit does not move A to the back: insertion order is not LRU.
    expect(await execute(keyA1, 'a')).toEqual({ status: 'accepted', value: 'a-1' });
    expect(await execute(keyA2, 'c')).toEqual({ status: 'accepted', value: 'c-1' });

    // A was oldest and was evicted; adding it now evicts B next.
    expect(await execute(keyA1, 'a')).toEqual({ status: 'accepted', value: 'a-2' });
    expect(await execute(keyB1, 'b')).toEqual({ status: 'accepted', value: 'b-2' });
    expect(calls).toEqual(new Map([['a', 2], ['b', 2], ['c', 1]]));
  });
});
