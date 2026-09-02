import { describe, expect, it } from 'vitest';

import {
  buildApprovalResolutionCommand,
  buildChatDispatchCommand,
  buildInputResolutionCommand,
  insertSlashCommand,
} from '../src/features/chat/chatCommands';

const chatUri = 'agent-chat://workspace-a/chat-a';

describe('chat command builders', () => {
  it('inserts a slash command at the composer selection without replacing the draft', () => {
    expect(insertSlashCommand(
      '请先检查，然后继续',
      { start: 5, end: 5 },
      { name: 'animate', argumentHint: '<target>' },
    )).toEqual({
      text: '请先检查， /animate <target> 然后继续',
      cursor: 24,
    });

    expect(insertSlashCommand(
      '保留前文',
      { start: 4, end: 4 },
      { name: 'review', argumentHint: '' },
    )).toEqual({
      text: '保留前文 /review ',
      cursor: 13,
    });
  });

  it('builds a send command with the exact dispatchAction wire shape', () => {
    expect(buildChatDispatchCommand({
      channel: chatUri,
      action: { type: 'chat/send', prompt: '  检查 SSH 连接  ' },
      clientSeq: 7,
      commandId: 'send-7',
    })).toEqual({
      method: 'dispatchAction',
      params: {
        channel: chatUri,
        clientSeq: 7,
        commandId: 'send-7',
        action: { type: 'chat/send', prompt: '检查 SSH 连接' },
      },
    });
  });

  it('builds an interrupt command without optimistic turn mutation', () => {
    expect(buildChatDispatchCommand({
      channel: chatUri,
      action: { type: 'chat/interrupt', turnId: 'turn-a' },
      clientSeq: 8,
      commandId: 'interrupt-8',
    })).toEqual({
      method: 'dispatchAction',
      params: {
        channel: chatUri,
        clientSeq: 8,
        commandId: 'interrupt-8',
        action: { type: 'chat/interrupt', turnId: 'turn-a' },
      },
    });
  });

  it('builds allow and deny with optional SDK-free fields preserved', () => {
    expect(buildApprovalResolutionCommand({
      channel: chatUri,
      approvalId: 'approval-a',
      decision: 'allow',
      decisionClassification: 'user_temporary',
      updatedInput: { command: 'systemctl restart sshd' },
      clientSeq: 9,
      commandId: 'approval-9',
    })).toEqual({
      method: 'chat/resolveApproval',
      params: {
        channel: chatUri,
        clientSeq: 9,
        commandId: 'approval-9',
        approvalId: 'approval-a',
        decision: 'allow',
        decisionClassification: 'user_temporary',
        updatedInput: { command: 'systemctl restart sshd' },
      },
    });

    expect(buildApprovalResolutionCommand({
      channel: chatUri,
      approvalId: 'approval-b',
      decision: 'deny',
      decisionClassification: 'user_reject',
      message: '用户拒绝执行此命令',
      interrupt: true,
      clientSeq: 10,
      commandId: 'approval-10',
    }).params).toMatchObject({ decision: 'deny', interrupt: true });
  });

  it('builds structured input answers and rejects empty command data', () => {
    expect(buildInputResolutionCommand({
      channel: chatUri,
      inputId: 'input-a',
      answers: { 'Which mode should be used?': '远程主机', 'Should changes be applied?': '是' },
      clientSeq: 11,
      commandId: 'input-11',
    })).toEqual({
      method: 'chat/resolveInput',
      params: {
        channel: chatUri,
        clientSeq: 11,
        commandId: 'input-11',
        inputId: 'input-a',
        answers: { 'Which mode should be used?': '远程主机', 'Should changes be applied?': '是' },
      },
    });

    expect(() => buildChatDispatchCommand({
      channel: chatUri,
      action: { type: 'chat/send', prompt: '  ' },
      clientSeq: 12,
      commandId: 'send-12',
    })).toThrow(TypeError);
    expect(() => buildInputResolutionCommand({
      channel: chatUri,
      inputId: '',
      clientSeq: 13,
      commandId: 'input-13',
    })).toThrow(TypeError);
  });
});
