import { describe, expect, it } from 'vitest';

import {
  createApprovalId,
  createInputRequestId,
  createPartId,
  createToolCallId,
  createTurnId,
  type ResponsePartAddedAction,
} from '../../src/index.js';

const turn = createTurnId('turn-1');
const markdownPart = createPartId('part-markdown');
const reasoningPart = createPartId('part-reasoning');
const toolPart = createPartId('part-tool');
const toolCall = createToolCallId('tool-1');
const approval = createApprovalId('approval-1');
const input = createInputRequestId('input-1');

describe('ResponsePartAddedAction', () => {
  it('accepts markdown and reasoning response parts', () => {
    const markdownAction: ResponsePartAddedAction = {
      type: 'chat/responsePartAdded',
      turnId: turn,
      part: { kind: 'markdown', id: markdownPart, content: '' },
      timestamp: 'markdown',
    };
    const reasoningAction: ResponsePartAddedAction = {
      type: 'chat/responsePartAdded',
      turnId: turn,
      part: { kind: 'reasoning', id: reasoningPart, content: '' },
      timestamp: 'reasoning',
    };

    expect([markdownAction.part.kind, reasoningAction.part.kind]).toEqual(['markdown', 'reasoning']);
  });

  it('rejects tool_call response parts at compile time', () => {
    const toolCallPart = {
      kind: 'tool_call' as const,
      id: toolPart,
      toolCall: {
        id: toolCall,
        name: 'read_file',
        input: '{}',
        status: 'started' as const,
        startedAt: 'tool-start',
      },
    };
    const invalidAction: ResponsePartAddedAction = {
      type: 'chat/responsePartAdded',
      turnId: turn,
      // @ts-expect-error ResponsePartAddedAction only accepts markdown or reasoning parts.
      part: toolCallPart,
      timestamp: 'tool-call',
    };

    expect(invalidAction).toBeDefined();
  });
});

describe('interaction actions', () => {
  it('keeps structured input answers JSON-safe and distinct from approval decisions', () => {
    const requested: import('../../src/index.js').InputRequestedAction = {
      type: 'chat/inputRequested',
      turnId: turn,
      inputId: input,
      questions: [{
        question: 'Which mode?',
        header: 'Mode',
        options: [
          { label: 'Fast', description: 'Quick' },
          { label: 'Safe', description: 'Careful' },
        ],
        multiSelect: false,
      }],
      timestamp: 'requested',
    };
    const resolved: import('../../src/index.js').InputResolvedAction = {
      type: 'chat/inputResolved',
      turnId: turn,
      inputId: input,
      answers: { 'Which mode?': 'Fast' },
      timestamp: 'resolved',
    };
    const approvalRequested: import('../../src/index.js').ApprovalRequestedAction = {
      type: 'chat/approvalRequested',
      turnId: turn,
      approvalId: approval,
      toolName: 'Bash',
      input: { command: 'echo ok' },
      title: 'Run command',
      description: 'Allow the command to run?',
      timestamp: 'approval-requested',
    };

    expect(requested.type).toBe('chat/inputRequested');
    expect(resolved.answers).toEqual({ 'Which mode?': 'Fast' });
    expect(approvalRequested).not.toHaveProperty('questions');
  });

  it('does not permit arbitrary answer values in the input action', () => {
    const invalid: import('../../src/index.js').InputResolvedAction = {
      type: 'chat/inputResolved',
      turnId: turn,
      inputId: input,
      // @ts-expect-error Input answers are strings, never SDK unknown values.
      answers: { 'Which mode?': { value: 'Fast' } },
      timestamp: 'invalid',
    };
    expect(invalid).toBeDefined();
  });
});
