import type { UUID } from 'node:crypto';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  type ClaudeRuntimeState,
  type ClaudeTurnHandle,
  type ClaudeTurnOutcome,
} from '../../src/index.js';
import type { ClaudeRuntimeSignal } from '../../src/claude/runtimeTypes.js';
import { createTurnId, type TurnId } from '../../src/domain/ids.js';

const sdkUuid: UUID = '00000000-0000-4000-8000-000000000003';
const turnId: TurnId = createTurnId('turn-1');
const sdkMessage = Object.create(null) as SDKMessage;

if (false) {
  const state: ClaudeRuntimeState = 'running';
  const outcome: ClaudeTurnOutcome = { status: 'completed', resultSubtype: 'success' };
  const handle: ClaudeTurnHandle = {
    turnId,
    sdkUuid,
    accepted: Promise.resolve(),
    completed: Promise.resolve(outcome),
  };
  const messageSignal: ClaudeRuntimeSignal = {
    type: 'runtime/message',
    generation: 1,
    phase: 'active',
    message: sdkMessage,
  };

  void state;
  void handle;
  void messageSignal;
}

describe('Phase 3 runtime type boundaries', () => {
  it('keeps public turn handles SDK-free apart from the UUID primitive', () => {
    expectTypeOf<ClaudeTurnHandle['turnId']>().toEqualTypeOf<TurnId>();
    expectTypeOf<ClaudeTurnHandle['sdkUuid']>().toEqualTypeOf<UUID>();
    expectTypeOf<ClaudeTurnHandle['accepted']>().toEqualTypeOf<Promise<void>>();
    expectTypeOf<ClaudeTurnHandle['completed']>().toEqualTypeOf<Promise<ClaudeTurnOutcome>>();
  });

  it('exposes the documented runtime states and outcome discriminants', () => {
    const states: ClaudeRuntimeState[] = ['starting', 'running', 'closing', 'closed', 'crashed'];
    const outcomes: ClaudeTurnOutcome[] = [
      { status: 'completed', resultSubtype: 'success' },
      { status: 'failed', message: 'failed' },
      { status: 'failed', resultSubtype: 'error', message: 'failed' },
      { status: 'interrupted' },
      { status: 'runtime_closed', message: 'closed' },
    ];

    expect(states).toHaveLength(5);
    expect(outcomes).toHaveLength(5);
  });
});
