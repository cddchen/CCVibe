import type {
  CanUseTool,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';
import type { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PendingInteractionRegistry,
  type InteractionAction,
  type InteractionTimer,
} from '../../src/interaction/pendingInteractionRegistry.js';

const CHAT = 'agent-chat://session/chat';
const OTHER_CHAT = 'agent-chat://session/other';
const TURN = 'turn-1';

class FakeTimer implements InteractionTimer {
  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();

  public setTimeout(callback: () => void, _delayMs: number): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') {
      this.callbacks.delete(handle);
    }
  }

  public fireAll(): void {
    for (const [id, callback] of [...this.callbacks]) {
      this.callbacks.delete(id);
      callback();
    }
  }

  public get size(): number {
    return this.callbacks.size;
  }
}

interface Harness {
  readonly registry: PendingInteractionRegistry;
  readonly actions: InteractionAction[];
  readonly timer: FakeTimer;
  readonly nowCalls: number[];
}

function makeHarness(
  onDispatch?: (chat: string, action: InteractionAction) => void,
): Harness {
  const actions: InteractionAction[] = [];
  const timer = new FakeTimer();
  const nowCalls: number[] = [];
  let approvalIndex = 0;
  let inputIndex = 0;
  const registry = new PendingInteractionRegistry({
    dispatch: (chat, action) => {
      actions.push(action);
      onDispatch?.(chat, action);
    },
    now: () => {
      nowCalls.push(nowCalls.length + 1);
      return `timestamp-${nowCalls.length}`;
    },
    createApprovalId: () => `approval-${++approvalIndex}`,
    createInputId: () => `input-${++inputIndex}`,
    timer,
  });
  return { registry, actions, timer, nowCalls };
}

function approvalRequest(
  registry: PendingInteractionRegistry,
  extra: Partial<{
    readonly approvalId: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }> = {},
): Promise<PermissionResult> {
  return registry.requestApproval({
    chat: CHAT,
    turnId: TURN,
    toolName: 'Bash',
    input: { command: 'echo ok' },
    ...extra,
  });
}

const askQuestion = {
  question: 'Which mode should be used?',
  header: 'Mode',
  options: [
    { label: 'Fast', description: 'Use the fast mode.' },
    { label: 'Safe', description: 'Use the safe mode.' },
  ],
  multiSelect: false,
};

const askInput = {
  questions: [askQuestion],
} as unknown as AskUserQuestionInput;

describe('PendingInteractionRegistry', () => {
  it('requires injected identity/time dependencies and uses the official callback signature', () => {
    const harness = makeHarness();
    const callback = harness.registry.createCanUseTool({ chat: CHAT, turnId: TURN });

    expectTypeOf(callback).toEqualTypeOf<CanUseTool>();
    expectTypeOf<Parameters<CanUseTool>>().toEqualTypeOf<Parameters<CanUseTool>>();
    expect(harness.registry.size).toBe(0);
  });

  it('publishes an approval request before allowing a synchronous resolution and settles once', async () => {
    let waiterSettled = false;
    const harness = makeHarness((_chat, action) => {
      if (action.type === 'chat/approvalResolved') {
        expect(waiterSettled).toBe(false);
      }
    });

    const waiter = approvalRequest(harness.registry, { approvalId: 'approval-fixed' });
    expect(harness.registry.size).toBe(1);
    expect(harness.actions[0]).toMatchObject({
      type: 'chat/approvalRequested',
      turnId: TURN,
      approvalId: 'approval-fixed',
      toolName: 'Bash',
      input: { command: 'echo ok' },
      requestedAt: 'timestamp-1',
      timestamp: 'timestamp-1',
    });

    const winner = harness.registry.resolveApproval({
      chat: CHAT,
      approvalId: 'approval-fixed',
      decision: 'allow',
    });
    const loser = harness.registry.resolveApproval({
      chat: CHAT,
      approvalId: 'approval-fixed',
      decision: 'deny',
    });
    expect(winner).toEqual({ status: 'resolved', kind: 'approval', id: 'approval-fixed' });
    expect(loser).toEqual({ status: 'already_resolved', kind: 'approval', id: 'approval-fixed' });
    expect(harness.registry.size).toBe(0);
    waiterSettled = true;

    await expect(waiter).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'echo ok' },
    });
    expect(harness.actions.filter((action) => action.type === 'chat/approvalResolved')).toHaveLength(1);
    expect(harness.nowCalls).toHaveLength(2);
  });

  it('keeps request-before-resolution order under a reentrant dispatcher', async () => {
    let registry!: PendingInteractionRegistry;
    const actions: InteractionAction[] = [];
    registry = new PendingInteractionRegistry({
      dispatch: (_chat, action) => {
        actions.push(action);
        if (action.type === 'chat/approvalRequested') {
          expect(registry.resolveApproval({
            chat: CHAT,
            approvalId: action.approvalId,
            decision: 'allow',
          }).status).toBe('resolved');
        }
      },
      now: () => 'timestamp',
      createApprovalId: () => 'approval-reentrant',
      createInputId: () => 'input-reentrant',
      timer: new FakeTimer(),
    });

    await expect(approvalRequest(registry)).resolves.toMatchObject({ behavior: 'allow' });
    expect(actions.map((action) => action.type)).toEqual([
      'chat/approvalRequested',
      'chat/approvalResolved',
    ]);
    expect(registry.size).toBe(0);
  });

  it('keeps an invalid or mismatched response retryable without publishing a resolution', async () => {
    const harness = makeHarness();
    const waiter = approvalRequest(harness.registry, { approvalId: 'approval-retry' });

    expect(harness.registry.resolveApproval({
      chat: OTHER_CHAT,
      approvalId: 'approval-retry',
      decision: 'allow',
    })).toEqual({ status: 'chat_mismatch', kind: 'approval', id: 'approval-retry' });
    expect(harness.registry.resolveApproval({
      chat: CHAT,
      approvalId: 'approval-retry',
      decision: 'maybe' as never,
    })).toMatchObject({ status: 'rejected', code: 'invalid_decision' });
    expect(harness.registry.size).toBe(1);
    expect(harness.actions.filter((action) => action.type === 'chat/approvalResolved')).toHaveLength(0);

    expect(harness.registry.resolveApproval({
      chat: CHAT,
      approvalId: 'approval-retry',
      decision: 'deny',
      message: 'No',
    }).status).toBe('resolved');
    await expect(waiter).resolves.toMatchObject({ behavior: 'deny', message: 'No' });
  });

  it('propagates the complete official permission result and callback context', async () => {
    const harness = makeHarness();
    const permissionResult: PermissionResult = {
      behavior: 'allow',
      updatedInput: { command: 'echo changed' },
      updatedPermissions: [],
      toolUseID: 'tool-use-1',
      decisionClassification: 'user_permanent',
    };
    const waiter = harness.registry.requestApproval({
      chat: CHAT,
      turnId: TURN,
      approvalId: 'approval-context',
      toolCallId: 'tool-call-1',
      toolName: 'Bash',
      input: { command: 'echo original' },
      options: {
        signal: new AbortController().signal,
        toolUseID: 'tool-use-1',
        requestId: 'sdk-request-1',
        title: 'Run command',
        displayName: 'Shell',
        description: 'Run a shell command',
        blockedPath: '/tmp/file',
        decisionReason: 'outside workspace',
      },
    });

    const pending = harness.registry.getPending('approval', 'approval-context');
    expect(pending).toMatchObject({
      toolCallId: 'tool-call-1',
      sdkRequestId: 'sdk-request-1',
      toolUseID: 'tool-use-1',
      title: 'Run command',
      displayName: 'Shell',
      blockedPath: '/tmp/file',
    });
    expect(harness.registry.resolveApproval({
      chat: CHAT,
      approvalId: 'approval-context',
      decision: permissionResult,
    }).status).toBe('resolved');
    await expect(waiter).resolves.toEqual(permissionResult);

    const resolution = harness.actions.find((action) => action.type === 'chat/approvalResolved');
    expect(resolution).toMatchObject({
      decision: 'allow',
      updatedInput: { command: 'echo changed' },
      updatedPermissions: [],
      decisionClassification: 'user_permanent',
    });
  });

  it('settles abort, timeout, chat cancellation, and dispose exactly once', async () => {
    const controller = new AbortController();
    const harness = makeHarness();
    const aborted = approvalRequest(harness.registry, { approvalId: 'approval-abort', signal: controller.signal });
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ behavior: 'deny', message: 'SDK aborted the tool request' });
    expect(harness.registry.resolveApproval({
      chat: CHAT,
      approvalId: 'approval-abort',
      decision: 'allow',
    })).toEqual({ status: 'already_resolved', kind: 'approval', id: 'approval-abort' });

    const timed = approvalRequest(harness.registry, { approvalId: 'approval-timeout', timeoutMs: 1000 });
    expect(harness.timer.size).toBe(1);
    harness.timer.fireAll();
    await expect(timed).resolves.toMatchObject({ behavior: 'deny', message: 'Permission request timed out' });
    expect(harness.timer.size).toBe(0);

    const canceled = approvalRequest(harness.registry, { approvalId: 'approval-chat' });
    const survivor = harness.registry.requestInput({
      chat: OTHER_CHAT,
      turnId: TURN,
      inputId: 'input-survivor',
      questions: askInput.questions,
    });
    harness.registry.cancelChat(CHAT, 'turn ended');
    await expect(canceled).resolves.toMatchObject({ behavior: 'deny', message: 'turn ended' });
    expect(harness.registry.getPending('input', 'input-survivor')).toBeDefined();

    harness.registry.dispose();
    await expect(survivor).resolves.toBeUndefined();
    expect(harness.registry.size).toBe(0);
    expect(harness.registry.isDisposed).toBe(true);
    harness.registry.dispose();
    expect(harness.registry.resolveInput({
      chat: OTHER_CHAT,
      inputId: 'input-survivor',
      answers: {},
    })).toEqual({ status: 'already_resolved', kind: 'input', id: 'input-survivor' });
  });

  it('bridges AskUserQuestion as structured input and never as an approval decision', async () => {
    const harness = makeHarness();
    const callback = harness.registry.createCanUseTool({ chat: CHAT, turnId: TURN });
    const controller = new AbortController();
    const pending = callback('AskUserQuestion', askInput as unknown as Record<string, unknown>, {
      signal: controller.signal,
      toolUseID: 'input-tool-1',
      requestId: 'sdk-request-2',
    });

    expect(harness.registry.getPending('input', 'input-tool-1')).toMatchObject({
      kind: 'input',
      questions: [{ question: 'Which mode should be used?' }],
    });
    expect(harness.registry.getPending('approval', 'input-tool-1')).toBeUndefined();
    expect(harness.actions[0]).toMatchObject({ type: 'chat/inputRequested', inputId: 'input-tool-1' });

    expect(harness.registry.resolveInput({
      chat: CHAT,
      inputId: 'input-tool-1',
      answers: { 'Which mode should be used?': 'Fast' },
    }).status).toBe('resolved');
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: askInput.questions,
        answers: { 'Which mode should be used?': 'Fast' },
      },
    });
    expect(harness.actions.filter((action) => action.type === 'chat/approvalRequested')).toHaveLength(0);
  });

  it('rejects malformed structured answers while leaving the input waiter available', async () => {
    const harness = makeHarness();
    const waiter = harness.registry.requestInput({
      chat: CHAT,
      turnId: TURN,
      inputId: 'input-retry',
      questions: askInput.questions,
    });

    expect(harness.registry.resolveInput({
      chat: CHAT,
      inputId: 'input-retry',
      answers: { Unknown: 'value' },
    })).toMatchObject({ status: 'rejected', code: 'invalid_answers' });
    expect(harness.registry.size).toBe(1);
    expect(harness.registry.resolveInput({
      chat: CHAT,
      inputId: 'input-retry',
      answers: { 'Which mode should be used?': 'Safe' },
    }).status).toBe('resolved');
    await expect(waiter).resolves.toEqual({ 'Which mode should be used?': 'Safe' });
  });
});
