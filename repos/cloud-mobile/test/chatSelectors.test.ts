import { describe, expect, it } from 'vitest';

import {
  buildStructuredInputAnswers,
  formatTurnDuration,
  parseMarkdownBlocks,
  selectChatViewModel,
  type PendingInputViewModel,
} from '../src/features/chat/chatSelectors';
import type { HostChatState, HostRootCatalogState } from '../src/protocol/hostWire';
import { createChatUri, createRootUri } from '../src/protocol/resourceUri';

const chatUri = createChatUri('workspace-a', 'chat-a');
const rootState: HostRootCatalogState = {
  resource: createRootUri(),
  host: { id: 'host-a', displayName: 'dev-host' },
  connection: { status: 'connected', displayStatus: 'online' },
  workspaces: [{ id: 'workspace-a', path: '/srv/cc-agent-host', displayName: 'cc-agent-host', status: 'available' }],
  sessions: [{
    chatUri,
    sdkSessionRef: 'sdk-a',
    workspaceId: 'workspace-a',
    title: '修复连接超时问题',
    updatedAt: '2026-08-29T10:00:00.000Z',
    status: 'in_progress',
    archived: false,
  }],
  models: [{ id: 'model-a', displayName: 'GPT-5.6 Terra', capabilities: ['effort'] }],
  defaultModelId: 'model-a',
  modifiedAt: '2026-08-29T10:00:00.000Z',
};

const chatState: HostChatState = {
  resource: chatUri,
  status: 'input_needed',
  turns: [{
    id: 'turn-old',
    prompt: '先检查端口',
    status: 'complete',
    parts: [{ kind: 'markdown', id: 'old-answer', content: '端口已经恢复。' }],
    startedAt: '2026-08-29T09:00:00.000Z',
    completedAt: '2026-08-29T09:01:00.000Z',
  }],
  activeTurn: {
    id: 'turn-active',
    prompt: '请继续诊断 SSH 连接',
    status: 'active',
    parts: [
      { kind: 'reasoning', id: 'reasoning-a', content: '我会先检查网络和 sshd 状态。' },
      {
        kind: 'tool_call',
        id: 'tool-part-a',
        toolCall: {
          id: 'tool-a',
          name: '执行终端命令',
          input: '{"command":"ss -tlnp | grep 22"}',
          status: 'completed',
          startedAt: '2026-08-29T09:02:00.000Z',
          completedAt: '2026-08-29T09:02:01.000Z',
          result: 'LISTEN 0 128 *:22',
        },
      },
      { kind: 'markdown', id: 'answer-a', content: '发现端口正常，下一步需要确认服务配置。' },
    ],
    startedAt: '2026-08-29T09:02:00.000Z',
  },
  pendingApprovals: [{
    id: 'approval-a',
    turnId: 'turn-active',
    toolCallId: 'tool-a',
    toolName: '执行终端命令',
    input: { command: 'sudo systemctl restart sshd.service' },
    title: '需要你的许可',
    requestedAt: '2026-08-29T09:03:00.000Z',
  }],
  pendingInputs: [{
    id: 'input-a',
    turnId: 'turn-active',
    requestedAt: '2026-08-29T09:04:00.000Z',
    questions: [{
      header: '目标环境',
      question: '选择要继续操作的环境',
      multiSelect: false,
      options: [
        { label: '远程主机', description: '使用当前 Host 连接' },
        { label: '本地工作区', description: '仅检查本地文件' },
      ],
    }],
  }],
  modifiedAt: '2026-08-29T09:04:00.000Z',
};

describe('canonical chat selector', () => {
  it('shows only server-canonical session model and effort values', () => {
    const configured = selectChatViewModel({
      chatUri,
      chatState,
      catalog: {
        ...rootState,
        sessions: [{ ...rootState.sessions[0], modelId: 'model-a', effort: 'high' }],
      },
    });
    expect(configured.modelId).toBe('model-a');
    expect(configured.modelDisplayName).toBe('GPT-5.6 Terra');
    expect(configured.effort).toBe('high');

    const unknown = selectChatViewModel({
      chatUri,
      chatState,
      catalog: {
        ...rootState,
        sessions: [{ ...rootState.sessions[0], modelId: 'provider-model', effort: undefined }],
      },
    });
    expect(unknown.modelId).toBeUndefined();
    expect(unknown.modelDisplayName).toBeUndefined();
    expect(unknown.effort).toBeUndefined();
    expect(unknown.models[0]?.supportedEffortLevels).toEqual([]);

    const unavailable = selectChatViewModel({ chatUri, chatState, catalog: rootState });
    expect(unavailable.modelId).toBeUndefined();
    expect(unavailable.modelDisplayName).toBeUndefined();
    expect(unavailable.effort).toBeUndefined();

    const unsupportedEffort = selectChatViewModel({
      chatUri,
      chatState,
      catalog: {
        ...rootState,
        models: [{ ...rootState.models[0], supportedEffortLevels: ['low', 'medium'] }],
        sessions: [{ ...rootState.sessions[0], modelId: 'model-a', effort: 'max' }],
      },
    });
    expect(unsupportedEffort.effort).toBeUndefined();
  });

  it('formats duration only from valid non-negative timestamp pairs', () => {
    expect(formatTurnDuration('2026-08-29T09:00:00.000Z', '2026-08-29T09:00:53.000Z')).toBe('用时0分53秒');
    expect(formatTurnDuration('not-a-time', '2026-08-29T09:00:53.000Z')).toBeUndefined();
    expect(formatTurnDuration('2026-08-29T09:01:00.000Z', '2026-08-29T09:00:53.000Z')).toBeUndefined();
  });

  it('projects history and active turn without duplicating the active turn', () => {
    const view = selectChatViewModel({ chatUri, chatState, catalog: rootState });

    expect(view.title).toBe('修复连接超时问题');
    expect(view.workspaceName).toBe('cc-agent-host');
    expect(view.hostName).toBe('dev-host');
    expect(view.history.map((turn) => turn.id)).toEqual(['turn-old']);
    expect(view.activeTurn?.id).toBe('turn-active');
    expect(view.transcript.filter((item) => item.turnId === 'turn-active')).toHaveLength(4);
  });

  it('keeps markdown, folds reasoning, and maps tool lifecycle into stable UI states', () => {
    const view = selectChatViewModel({ chatUri, chatState, catalog: rootState });
    const active = view.activeTurn;
    expect(active?.parts.find((part) => part.kind === 'reasoning')).toMatchObject({
      kind: 'reasoning',
      collapsed: true,
      content: '我会先检查网络和 sshd 状态。',
    });
    expect(active?.parts.find((part) => part.kind === 'tool')).toMatchObject({
      kind: 'tool',
      status: 'success',
      formattedInput: '{\n  "command": "ss -tlnp | grep 22"\n}',
      output: 'LISTEN 0 128 *:22',
    });
    expect(active?.parts.find((part) => part.kind === 'markdown')).toMatchObject({
      kind: 'markdown',
      blocks: [{ kind: 'paragraph', text: '发现端口正常，下一步需要确认服务配置。' }],
    });
  });

  it('normalizes pending approval and structured input without inventing optimistic state', () => {
    const view = selectChatViewModel({ chatUri, chatState, catalog: rootState });
    expect(view.pendingApprovals[0]).toMatchObject({
      id: 'approval-a',
      hostName: 'dev-host',
      toolName: '执行终端命令',
      normalizedInput: 'command: sudo systemctl restart sshd.service',
    });
    expect(view.pendingInputs[0]?.questions[0]).toMatchObject({
      header: '目标环境',
      multiSelect: false,
      options: [{ label: '远程主机' }, { label: '本地工作区' }],
    });
  });

  it('keeps a failed turn prompt and exposes a concise failure item without stack frames', () => {
    const failedChatState: HostChatState = {
      ...chatState,
      status: 'error',
      turns: [{
        id: 'turn-failed',
        prompt: '诊断远程连接超时',
        status: 'failed',
        parts: [],
        startedAt: '2026-08-29T09:05:00.000Z',
        completedAt: '2026-08-29T09:05:03.000Z',
        error: 'API Error: upstream request failed\n    at request (/srv/cc-agent-host/src/api.ts:42:7)\n    at processTask (internal/process/task_queues:95:5)',
      }],
      activeTurn: undefined,
      pendingApprovals: [],
      pendingInputs: [],
    };

    const view = selectChatViewModel({ chatUri, chatState: failedChatState, catalog: rootState });

    expect(view.transcript).toEqual([
      { key: 'turn-failed:prompt', turnId: 'turn-failed', kind: 'prompt', text: '诊断远程连接超时' },
      {
        key: 'turn-failed:failure',
        turnId: 'turn-failed',
        kind: 'failure',
        status: 'failed',
        message: 'API Error: upstream request failed',
      },
    ]);
    expect(view.history[0]).toMatchObject({
      id: 'turn-failed',
      status: 'failed',
      prompt: '诊断远程连接超时',
      error: 'API Error: upstream request failed',
    });
  });

  it('uses question.question as the Host answer key for option and free-text answers', () => {
    const input: PendingInputViewModel = {
      id: 'input-key-test',
      turnId: 'turn-active',
      questions: [{
        header: '模式',
        question: 'Which mode should be used?',
        multiSelect: false,
        options: [{ label: 'Remote', description: 'Use the connected host' }],
      }],
    };

    expect(buildStructuredInputAnswers(input, { 'Which mode should be used?': ['Remote'] }, {})).toEqual({
      'Which mode should be used?': 'Remote',
    });
    expect(buildStructuredInputAnswers(input, {}, { 'Which mode should be used?': '  Local  ' })).toEqual({
      'Which mode should be used?': 'Local',
    });
  });

  it('parses common markdown blocks deterministically', () => {
    expect(parseMarkdownBlocks('# 检查结果\n\n- 端口已监听\n- 服务已恢复\n\n```bash\nss -tlnp\n```')).toEqual([
      { kind: 'heading', level: 1, text: '检查结果' },
      { kind: 'bullet', text: '端口已监听' },
      { kind: 'bullet', text: '服务已恢复' },
      { kind: 'code', language: 'bash', text: 'ss -tlnp' },
    ]);
  });
});
