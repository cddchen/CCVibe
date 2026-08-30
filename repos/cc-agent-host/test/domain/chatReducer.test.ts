import { describe, expect, it } from 'vitest';

import {
  chatReducer,
  createApprovalId,
  createChatState,
  createInputRequestId,
  createPartId,
  createToolCallId,
  createTurnId,
  reduceChatActions,
  type ChatAction,
  type Turn,
} from '../../src/index.js';

const turn = createTurnId('turn-1');
const otherTurn = createTurnId('turn-2');
const markdownPart = createPartId('part-markdown');
const reasoningPart = createPartId('part-reasoning');
const toolPart = createPartId('part-tool');
const tool = createToolCallId('tool-1');
const approval = createApprovalId('approval-1');
const input = createInputRequestId('input-1');

const questions = [
  {
    question: 'Which mode should be used?',
    header: 'Mode',
    options: [
      { label: 'Fast', description: 'Use the fast mode.' },
      { label: 'Safe', description: 'Use the safe mode.' },
    ],
    multiSelect: false,
  },
] as const;

function start(timestamp = '2026-08-23T00:00:00.000Z'): ChatAction {
  return {
    type: 'chat/turnStarted',
    turnId: turn,
    prompt: 'Explain the change.',
    timestamp,
  };
}

describe('chatReducer', () => {
  it('reduces a complete prompt, response, tool, approval, and terminal lifecycle', () => {
    const initial = createChatState({ modifiedAt: 'initial' });
    const actions: readonly ChatAction[] = [
      start('t1'),
      {
        type: 'chat/responsePartAdded',
        turnId: turn,
        part: { kind: 'markdown', id: markdownPart, content: '' },
        timestamp: 't2',
      },
      {
        type: 'chat/responsePartDelta',
        turnId: turn,
        partId: markdownPart,
        delta: 'Hello',
        timestamp: 't3',
      },
      {
        type: 'chat/responsePartAdded',
        turnId: turn,
        part: { kind: 'reasoning', id: reasoningPart, content: 'thinking' },
        timestamp: 't4',
      },
      {
        type: 'chat/toolCallStarted',
        turnId: turn,
        partId: toolPart,
        toolCallId: tool,
        name: 'read_file',
        input: '{',
        timestamp: 't5',
      },
      {
        type: 'chat/toolCallInputDelta',
        turnId: turn,
        partId: toolPart,
        toolCallId: tool,
        delta: '"path":"README.md"}',
        timestamp: 't6',
      },
      {
        type: 'chat/toolCallReady',
        turnId: turn,
        partId: toolPart,
        toolCallId: tool,
        timestamp: 't7',
      },
      {
        type: 'chat/approvalRequested',
        turnId: turn,
        approvalId: approval,
        toolCallId: tool,
        toolName: 'read_file',
        input: { path: 'README.md' },
        description: 'Read a repository file',
        timestamp: 't8',
      },
      {
        type: 'chat/approvalResolved',
        turnId: turn,
        approvalId: approval,
        decision: 'allow',
        timestamp: 't9',
      },
      {
        type: 'chat/toolCallCompleted',
        turnId: turn,
        partId: toolPart,
        toolCallId: tool,
        result: 'file contents',
        timestamp: 't10',
      },
      {
        type: 'chat/turnCompleted',
        turnId: turn,
        timestamp: 't11',
      },
    ];

    const state = reduceChatActions(initial, actions);
    expect(state).toEqual({
      status: 'idle',
      turns: [
        {
          id: turn,
          prompt: 'Explain the change.',
          status: 'complete',
          parts: [
            { kind: 'markdown', id: markdownPart, content: 'Hello' },
            { kind: 'reasoning', id: reasoningPart, content: 'thinking' },
            {
              kind: 'tool_call',
              id: toolPart,
              toolCall: {
                id: tool,
                name: 'read_file',
                input: '{"path":"README.md"}',
                status: 'completed',
                startedAt: 't5',
                readyAt: 't7',
                completedAt: 't10',
                result: 'file contents',
              },
            },
          ],
          startedAt: 't1',
          completedAt: 't11',
        },
      ],
      pendingApprovals: [],
      pendingInputs: [],
      modifiedAt: 't11',
    });
  });

  it('is deterministic and only uses action timestamps', () => {
    const actions: readonly ChatAction[] = [
      start('first'),
      {
        type: 'chat/responsePartAdded',
        turnId: turn,
        part: { kind: 'markdown', id: markdownPart, content: '' },
        timestamp: 'second',
      },
      {
        type: 'chat/responsePartDelta',
        turnId: turn,
        partId: markdownPart,
        delta: 'same result',
        timestamp: 'third',
      },
    ];

    const first = reduceChatActions(createChatState({ modifiedAt: 'zero' }), actions);
    const second = reduceChatActions(createChatState({ modifiedAt: 'zero' }), actions);
    expect(second).toEqual(first);
    expect(first.modifiedAt).toBe('third');
  });

  it('returns the same state for invalid targets and refuses a second active turn', () => {
    const started = chatReducer(createChatState({ modifiedAt: 'initial' }), start());
    const invalidDelta = chatReducer(started, {
      type: 'chat/responsePartDelta',
      turnId: otherTurn,
      partId: markdownPart,
      delta: 'ignored',
      timestamp: 'wrong-turn',
    });
    const unknownTool = chatReducer(started, {
      type: 'chat/toolCallInputDelta',
      turnId: turn,
      partId: toolPart,
      toolCallId: tool,
      delta: '{}',
      timestamp: 'unknown-tool',
    });
    const secondTurn = chatReducer(started, {
      type: 'chat/turnStarted',
      turnId: otherTurn,
      prompt: 'must not replace the live turn',
      timestamp: 'second-turn',
    });

    expect(invalidDelta).toBe(started);
    expect(unknownTool).toBe(started);
    expect(secondTurn).toBe(started);
  });

  it('keeps tool input as partial JSON and rejects mismatched part/tool targets', () => {
    let state = chatReducer(createChatState({ modifiedAt: 'initial' }), start());
    state = chatReducer(state, {
      type: 'chat/toolCallStarted',
      turnId: turn,
      partId: toolPart,
      toolCallId: tool,
      name: 'write_file',
      input: '{"path":',
      timestamp: 'start',
    });

    const wrongPart = chatReducer(state, {
      type: 'chat/toolCallInputDelta',
      turnId: turn,
      partId: markdownPart,
      toolCallId: tool,
      delta: 'wrong',
      timestamp: 'wrong-part',
    });
    const wrongTool = chatReducer(state, {
      type: 'chat/toolCallInputDelta',
      turnId: turn,
      partId: toolPart,
      toolCallId: createToolCallId('other-tool'),
      delta: 'wrong',
      timestamp: 'wrong-tool',
    });

    expect(wrongPart).toBe(state);
    expect(wrongTool).toBe(state);
    expect(state.activeTurn?.parts[0]).toEqual({
      kind: 'tool_call',
      id: toolPart,
      toolCall: {
        id: tool,
        name: 'write_file',
        input: '{"path":',
        status: 'started',
        startedAt: 'start',
      },
    });
  });

  it('rejects runtime tool-part injection through responsePartAdded', () => {
    const state = chatReducer(createChatState({ modifiedAt: 'initial' }), start('turn-start'));
    const invalidAction = {
      type: 'chat/responsePartAdded',
      turnId: turn,
      part: {
        kind: 'tool_call',
        id: toolPart,
        toolCall: {
          id: tool,
          name: 'read_file',
          input: '{}',
          status: 'started',
          startedAt: 'tool-start',
        },
      },
      timestamp: 'tool-injected',
    } as unknown as ChatAction;

    expect(chatReducer(state, invalidAction)).toBe(state);
  });

  it.each(['ready', 'completed'] as const)('ignores tool input deltas after a tool call is %s', (status) => {
    let state = chatReducer(createChatState({ modifiedAt: 'initial' }), start('turn-start'));
    state = chatReducer(state, {
      type: 'chat/toolCallStarted',
      turnId: turn,
      partId: toolPart,
      toolCallId: tool,
      name: 'read_file',
      input: '{',
      timestamp: 'tool-start',
    });
    state = chatReducer(state, {
      type: 'chat/toolCallReady',
      turnId: turn,
      partId: toolPart,
      toolCallId: tool,
      timestamp: 'tool-ready',
    });
    if (status === 'completed') {
      state = chatReducer(state, {
        type: 'chat/toolCallCompleted',
        turnId: turn,
        partId: toolPart,
        toolCallId: tool,
        timestamp: 'tool-completed',
      });
    }

    const next = chatReducer(state, {
      type: 'chat/toolCallInputDelta',
      turnId: turn,
      partId: toolPart,
      toolCallId: tool,
      delta: 'late input',
      timestamp: 'late-input',
    });

    expect(next).toBe(state);
    expect(next.modifiedAt).toBe(status === 'ready' ? 'tool-ready' : 'tool-completed');
  });

  it('merges loaded history by turn id without replacing a live turn', () => {
    const historyTurn: Turn = {
      id: otherTurn,
      prompt: 'old prompt',
      status: 'complete',
      parts: [],
      startedAt: 'history-start',
      completedAt: 'history-end',
    };
    let state = chatReducer(createChatState({ modifiedAt: 'initial' }), start('live-start'));
    state = chatReducer(state, {
      type: 'chat/turnsLoaded',
      turns: [
        historyTurn,
        {
          ...historyTurn,
          prompt: 'duplicate should be ignored',
        },
        {
          id: turn,
          prompt: 'stale loaded copy',
          status: 'complete',
          parts: [],
          startedAt: 'stale',
          completedAt: 'stale-end',
        },
      ],
      timestamp: 'history-loaded',
    });

    expect(state.activeTurn?.id).toBe(turn);
    expect(state.activeTurn?.startedAt).toBe('live-start');
    expect(state.turns).toEqual([historyTurn]);
    expect(state.modifiedAt).toBe('history-loaded');
  });

  it('replaces stale completed history in place, appends new loaded turns, and preserves live state', () => {
    const existing: Turn = {
      id: otherTurn,
      prompt: 'stale prompt',
      status: 'complete',
      parts: [],
      startedAt: 'old-start',
      completedAt: 'old-end',
    };
    const replacement: Turn = {
      ...existing,
      prompt: 'authoritative prompt',
      completedAt: 'new-end',
    };
    const appended: Turn = {
      id: createTurnId('turn-3'),
      prompt: 'new prompt',
      status: 'complete',
      parts: [],
      startedAt: 'new-start',
      completedAt: 'new-end',
    };
    let state = chatReducer(
      createChatState({ turns: [existing], modifiedAt: 'initial' }),
      start('live-start'),
    );

    const loaded = chatReducer(state, {
      type: 'chat/turnsLoaded',
      turns: [replacement, appended, { ...appended, prompt: 'duplicate ignored' }],
      timestamp: 'loaded',
    });

    expect(loaded.activeTurn?.id).toBe(turn);
    expect(loaded.activeTurn?.startedAt).toBe('live-start');
    expect(loaded.turns).toEqual([replacement, appended]);
    expect(loaded.turns[0]).not.toBe(existing);
    expect(loaded.modifiedAt).toBe('loaded');

    state = loaded;
    const noOp = chatReducer(state, {
      type: 'chat/turnsLoaded',
      turns: state.turns,
      timestamp: 'same-values',
    });
    expect(noOp).toBe(state);
  });

  it('moves an active turn to history and clears only its pending approvals', () => {
    let state = chatReducer(createChatState({ modifiedAt: 'initial' }), start());
    state = chatReducer(state, {
      type: 'chat/toolCallStarted',
      turnId: turn,
      partId: toolPart,
      toolCallId: tool,
      name: 'read_file',
      timestamp: 'tool-start',
    });
    state = chatReducer(state, {
      type: 'chat/approvalRequested',
      turnId: turn,
      approvalId: approval,
      toolCallId: tool,
      toolName: 'read_file',
      input: { path: 'README.md' },
      description: 'permission',
      timestamp: 'approval',
    });
    state = chatReducer(state, {
      type: 'chat/turnInterrupted',
      turnId: turn,
      timestamp: 'interrupted',
    });

    expect(state.activeTurn).toBeUndefined();
    expect(state.status).toBe('idle');
    expect(state.pendingApprovals).toEqual([]);
    expect(state.turns[0]?.status).toBe('interrupted');
    expect(state.turns[0]?.completedAt).toBe('interrupted');
  });

  it('keeps structured input separate from approval and resolves the final blocker deterministically', () => {
    let state = chatReducer(createChatState({ modifiedAt: 'initial' }), start());
    state = chatReducer(state, {
      type: 'chat/inputRequested',
      turnId: turn,
      inputId: input,
      questions,
      timestamp: 'input-requested',
    });

    expect(state.status).toBe('input_needed');
    expect(state.pendingInputs).toEqual([{
      id: input,
      turnId: turn,
      questions,
      requestedAt: 'input-requested',
    }]);

    const resolved = chatReducer(state, {
      type: 'chat/inputResolved',
      turnId: turn,
      inputId: input,
      answers: { 'Which mode should be used?': 'Fast' },
      timestamp: 'input-resolved',
    });
    expect(resolved.pendingInputs).toEqual([]);
    expect(resolved.status).toBe('in_progress');

    // Replaying a settled input action is a pure no-op and cannot move the
    // active turn's status or modifiedAt backwards.
    expect(chatReducer(resolved, {
      type: 'chat/inputResolved',
      turnId: turn,
      inputId: input,
      answers: { 'Which mode should be used?': 'Fast' },
      timestamp: 'late',
    })).toBe(resolved);
  });

  it('rejects malformed structured input actions without leaking values into state', () => {
    const started = chatReducer(createChatState({ modifiedAt: 'initial' }), start());
    const malformedQuestions = {
      type: 'chat/inputRequested',
      turnId: turn,
      inputId: input,
      questions: [{ question: 'Q?', header: 'Q', options: [], multiSelect: false }],
      timestamp: 'malformed',
    } as unknown as ChatAction;
    expect(chatReducer(started, malformedQuestions)).toBe(started);

    const requested = chatReducer(started, {
      type: 'chat/inputRequested',
      turnId: turn,
      inputId: input,
      questions,
      timestamp: 'requested',
    });
    const malformedAnswers = {
      type: 'chat/inputResolved',
      turnId: turn,
      inputId: input,
      answers: { 'Which mode should be used?': ['Fast'] },
      timestamp: 'malformed-answer',
    } as unknown as ChatAction;
    expect(chatReducer(requested, malformedAnswers)).toBe(requested);
  });

  it('cleans approval and structured-input blockers for a terminal turn', () => {
    let state = chatReducer(createChatState({ modifiedAt: 'initial' }), start());
    state = chatReducer(state, {
      type: 'chat/inputRequested',
      turnId: turn,
      inputId: input,
      questions,
      timestamp: 'input-requested',
    });
    state = chatReducer(state, {
      type: 'chat/turnInterrupted',
      turnId: turn,
      timestamp: 'interrupted',
    });

    expect(state.activeTurn).toBeUndefined();
    expect(state.pendingApprovals).toEqual([]);
    expect(state.pendingInputs).toEqual([]);
    expect(state.status).toBe('idle');
  });

  it('deep-copies opaque approval input and structured questions at the reducer boundary', () => {
    let state = chatReducer(createChatState({ modifiedAt: 'initial' }), start());
    const rawInput = { command: { value: 'echo ok' } };
    const action = {
      type: 'chat/approvalRequested' as const,
      turnId: turn,
      approvalId: approval,
      toolName: 'Bash',
      input: rawInput,
      timestamp: 'approval-requested',
    };
    state = chatReducer(state, action);
    rawInput.command.value = 'changed';
    expect(state.pendingApprovals[0]?.input).toEqual({ command: { value: 'echo ok' } });

    const mutableQuestions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }> = questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    }));
    state = chatReducer(state, {
      type: 'chat/inputRequested',
      turnId: turn,
      inputId: createInputRequestId('input-copy'),
      questions: mutableQuestions,
      timestamp: 'input-requested',
    });
    mutableQuestions[0]!.options[0]!.label = 'changed';
    expect(state.pendingInputs?.[0]?.questions[0]?.options[0]?.label).toBe('Fast');
  });

  it('does not mutate the initial state arrays', () => {
    const initial = createChatState({ modifiedAt: 'initial' });
    const initialTurns = initial.turns;
    const initialApprovals = initial.pendingApprovals;
    const next = chatReducer(initial, start());

    expect(initial.turns).toBe(initialTurns);
    expect(initial.pendingApprovals).toBe(initialApprovals);
    expect(initial.activeTurn).toBeUndefined();
    expect(next).not.toBe(initial);
  });
});
