import { describe, expect, it } from 'vitest';

import {
  buildCreateChatCommand,
  buildSendChatCommand,
} from '../src/features/home/createChatCommand';
import { createChatUri, createRootUri } from '../src/protocol/resourceUri';

describe('Phase 3 chat command builders', () => {
  it('builds the exact Host catalog/createChat request with the root channel', () => {
    expect(buildCreateChatCommand({
      workspaceId: 'workspace-a',
      modelId: 'model-a',
      prompt: '修复连接超时问题',
      clientSeq: 7,
      commandId: 'create-command-7',
    })).toEqual({
      method: 'catalog/createChat',
      params: {
        channel: createRootUri(),
        workspaceId: 'workspace-a',
        modelId: 'model-a',
        initialPrompt: '修复连接超时问题',
        clientSeq: 7,
        commandId: 'create-command-7',
      },
    });
  });

  it('builds dispatchAction with a new command sequence and typed chat/send intent', () => {
    const chatUri = createChatUri('session-a', 'chat-a');

    expect(buildSendChatCommand({
      channel: chatUri,
      prompt: '请检查服务状态',
      clientSeq: 8,
      commandId: 'send-command-8',
    })).toEqual({
      method: 'dispatchAction',
      params: {
        channel: chatUri,
        clientSeq: 8,
        commandId: 'send-command-8',
        action: { type: 'chat/send', prompt: '请检查服务状态' },
      },
    });
  });

  it('rejects empty prompts before they can reach the Host', () => {
    expect(() => buildCreateChatCommand({
      workspaceId: 'workspace-a',
      modelId: 'model-a',
      prompt: '  ',
      clientSeq: 1,
      commandId: 'create-command-1',
    })).toThrow('prompt is required');
  });
});
