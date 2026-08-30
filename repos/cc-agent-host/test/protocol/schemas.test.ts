import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createChatUri,
  createClientId,
  createCommandId,
  createConnectionId,
  createModelId,
  createRootUri,
  createTurnId,
  createWorkspaceId,
  MAX_CLIENT_INFO_FIELD_BYTES,
  MAX_OPAQUE_ID_BYTES,
  MAX_PROMPT_BYTES,
  MAX_SUBSCRIPTIONS,
  type ClientAction,
  type DispatchActionParams,
  type InitializeParams,
  type RootUri,
} from '../../src/index.js';
import {
  agentResourceSchema,
  clientActionSchema,
  clientIdSchema,
  catalogCreateChatParamsSchema,
  dispatchActionParamsSchema,
  initializeParamsSchema,
  reconnectParamsSchema,
  rootUriSchema,
  subscribeParamsSchema,
  toSafeValidationIssues,
} from '../../src/protocol/schemas.js';

const root = createRootUri();
const chat = createChatUri('session-1', 'chat-1');
const client = createClientId('client-1');
const command = createCommandId('command-1');
const validInitialize: InitializeParams = {
  channel: root,
  protocolVersions: ['1.0.0'],
  clientId: client,
  clientInfo: {
    name: 'test-client',
    version: '1.0.0',
    platform: 'test',
  },
  capabilities: {
    partialBlocks: true,
    approvalEdits: false,
  },
  initialSubscriptions: [chat],
};

expectTypeOf<InitializeParams['channel']>().toEqualTypeOf<RootUri>();
expectTypeOf<InitializeParams['clientId']>().toEqualTypeOf<ReturnType<typeof createClientId>>();
expectTypeOf<DispatchActionParams['commandId']>().toEqualTypeOf<ReturnType<typeof createCommandId>>();
expectTypeOf<ClientAction>().toMatchTypeOf<
  | { readonly type: 'chat/send'; readonly prompt: string }
  | { readonly type: 'chat/interrupt'; readonly turnId: ReturnType<typeof createTurnId> }
>();

if (false) {
  const rawChatAction = {
    type: 'chat/turnStarted' as const,
    turnId: createTurnId('turn-1'),
    prompt: 'raw action must not be accepted',
    timestamp: 'timestamp',
  };
  const validDispatch: DispatchActionParams = {
    channel: chat,
    clientSeq: 1,
    commandId: command,
    action: { type: 'chat/send', prompt: 'typed intent' },
  };
  // @ts-expect-error DispatchActionParams accepts only typed client intents.
  const invalid: DispatchActionParams = { ...validDispatch, action: rawChatAction };
  void invalid;
}

describe('Phase 1 protocol schemas', () => {
  it('strictly validates catalog create chat params', () => {
    const parsed = catalogCreateChatParamsSchema.parse({
      channel: root,
      workspaceId: createWorkspaceId('workspace-a'),
      modelId: createModelId('model-a'),
      initialPrompt: 'start later',
      clientSeq: 1,
      commandId: createCommandId('create-chat-1'),
    });

    expect(parsed.workspaceId).toBe(createWorkspaceId('workspace-a'));
    expect(() => catalogCreateChatParamsSchema.parse({
      ...parsed,
      extra: true,
    })).toThrow();
    expect(() => catalogCreateChatParamsSchema.parse({
      ...parsed,
      channel: chat,
    })).toThrow();
  });

  it('parses initialize and constructs branded values through the domain parsers', () => {
    const result = initializeParamsSchema.safeParse(validInitialize);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.channel).toBe(root);
    expect(result.data.clientId).toBe(client);
    expect(result.data.initialSubscriptions).toEqual([chat]);
  });

  it('keeps all protocol objects strict, including nested client and intent objects', () => {
    const unknownTopLevel = initializeParamsSchema.safeParse({ ...validInitialize, unexpected: true });
    const unknownNested = initializeParamsSchema.safeParse({
      ...validInitialize,
      clientInfo: { ...validInitialize.clientInfo, secret: 'do not echo' },
    });
    const unknownIntent = clientActionSchema.safeParse({ type: 'chat/send', prompt: 'hello', secret: 'do not echo' });

    expect(unknownTopLevel.success).toBe(false);
    expect(unknownNested.success).toBe(false);
    expect(unknownIntent.success).toBe(false);
  });

  it('accepts the two typed client intents and rejects raw domain actions', () => {
    const send = dispatchActionParamsSchema.safeParse({
      channel: chat,
      clientSeq: 1,
      commandId: command,
      action: { type: 'chat/send', prompt: 'hello' },
    });
    const interrupt = dispatchActionParamsSchema.safeParse({
      channel: chat,
      clientSeq: 2,
      commandId: command,
      action: { type: 'chat/interrupt', turnId: createTurnId('turn-1') },
    });
    const raw = dispatchActionParamsSchema.safeParse({
      channel: chat,
      clientSeq: 3,
      commandId: command,
      action: {
        type: 'chat/turnStarted',
        turnId: createTurnId('turn-1'),
        prompt: 'raw domain action',
        timestamp: 'timestamp',
      },
    });

    expect(send.success).toBe(true);
    expect(interrupt.success).toBe(true);
    expect(raw.success).toBe(false);
    if (interrupt.success) {
      expect(interrupt.data.action).toEqual({ type: 'chat/interrupt', turnId: createTurnId('turn-1') });
    }
  });

  it('enforces documented ID, URI, prompt, client-info, subscription, and integer limits', () => {
    expect(clientIdSchema.safeParse('x'.repeat(MAX_OPAQUE_ID_BYTES)).success).toBe(true);
    expect(clientIdSchema.safeParse('x'.repeat(MAX_OPAQUE_ID_BYTES + 1)).success).toBe(false);
    expect(rootUriSchema.safeParse(root).success).toBe(true);
    expect(rootUriSchema.safeParse('agent-session://session-1').success).toBe(false);
    expect(agentResourceSchema.safeParse('agent-chat://session-1/chat-1?query=secret').success).toBe(false);
    expect(agentResourceSchema.safeParse(`agent-chat://${'x'.repeat(MAX_OPAQUE_ID_BYTES + 1)}/chat-1`).success).toBe(false);

    const validDispatch = {
      channel: chat,
      clientSeq: 1,
      commandId: command,
      action: { type: 'chat/send' as const, prompt: 'hello' },
    };
    expect(
      dispatchActionParamsSchema.safeParse({
        ...validDispatch,
        action: { type: 'chat/send', prompt: 'x'.repeat(MAX_PROMPT_BYTES) },
      }).success,
    ).toBe(true);
    expect(
      dispatchActionParamsSchema.safeParse({
        ...validDispatch,
        action: { type: 'chat/send', prompt: 'x'.repeat(MAX_PROMPT_BYTES + 1) },
      }).success,
    ).toBe(false);

    expect(
      initializeParamsSchema.safeParse({
        ...validInitialize,
        clientInfo: { ...validInitialize.clientInfo, name: 'x'.repeat(MAX_CLIENT_INFO_FIELD_BYTES + 1) },
      }).success,
    ).toBe(false);
    expect(
      initializeParamsSchema.safeParse({
        ...validInitialize,
        initialSubscriptions: Array.from({ length: MAX_SUBSCRIPTIONS + 1 }, (_, index) =>
          createChatUri('session-1', `chat-${index}`),
        ),
      }).success,
    ).toBe(false);

    for (const clientSeq of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(dispatchActionParamsSchema.safeParse({ ...validDispatch, clientSeq }).success).toBe(false);
    }
    expect(reconnectParamsSchema.safeParse({
      channel: root,
      clientId: client,
      hostEpoch: 'epoch-1',
      lastSeenServerSeq: 0,
      subscriptions: [],
    }).success).toBe(true);
    expect(reconnectParamsSchema.safeParse({
      channel: root,
      clientId: client,
      hostEpoch: 'epoch-1',
      lastSeenServerSeq: -1,
      subscriptions: [],
    }).success).toBe(false);
    expect(subscribeParamsSchema.safeParse({ channel: chat }).success).toBe(true);
  });

  it('rejects malformed URI/ID syntax and returns only safe validation metadata', () => {
    expect(clientIdSchema.safeParse('').success).toBe(false);
    expect(clientIdSchema.safeParse('client/with-slash').success).toBe(false);
    expect(createConnectionId('connection-1')).toBe('connection-1');
    expect(() => createConnectionId('connection/with-slash')).toThrow(TypeError);
    expect(() => createConnectionId('x'.repeat(MAX_OPAQUE_ID_BYTES + 1))).toThrow(RangeError);

    const secret = 'super-secret-prompt-value';
    const invalid = dispatchActionParamsSchema.safeParse({
      ...validInitialize,
      channel: chat,
      clientSeq: 1,
      commandId: command,
      action: { type: 'chat/send', prompt: `${secret}${'x'.repeat(MAX_PROMPT_BYTES)}` },
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      const safe = toSafeValidationIssues(invalid.error);
      expect(JSON.stringify(safe)).not.toContain(secret);
      expect(safe.every((issue) => issue.path !== undefined && issue.code !== undefined)).toBe(true);
    }
  });
});
