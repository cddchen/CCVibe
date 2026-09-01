import type {
  AnyZodRawShape,
  InferShape,
  ModelInfo,
  SdkMcpToolDefinition,
  Options,
  Query,
  SDKUserMessage,
  WarmQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type {
  ClaudeSdkBindingName,
  ClaudeSdkBindings,
} from './sdkBindings.js';

export type ClaudeSdkLoader = () => Promise<ClaudeSdkBindings>;
export type ClaudeSdkLoadErrorReporter = (error: unknown) => void | PromiseLike<void>;

export interface ClaudeAgentSdkServiceOptions {
  readonly loadSdk?: ClaudeSdkLoader;
  readonly onLoadError?: ClaudeSdkLoadErrorReporter;
}

type ClaudeSdkMethod<K extends ClaudeSdkBindingName> = ClaudeSdkBindings[K];
type ClaudeSdkNonGenericBindingName = Exclude<ClaudeSdkBindingName, 'tool'>;
type ClaudeAgentSdkFacadeMethod<K extends ClaudeSdkNonGenericBindingName> = (
  ...args: Parameters<ClaudeSdkMethod<K>>
) => Promise<Awaited<ReturnType<ClaudeSdkMethod<K>>>>;
type ClaudeSdkToolExtras = NonNullable<Parameters<ClaudeSdkBindings['tool']>[4]>;

export type ClaudeAgentSdkServiceFacade = {
  [K in ClaudeSdkNonGenericBindingName]: ClaudeAgentSdkFacadeMethod<K>;
} & {
  tool<Schema extends AnyZodRawShape>(
    name: Parameters<ClaudeSdkBindings['tool']>[0],
    description: Parameters<ClaudeSdkBindings['tool']>[1],
    inputSchema: Schema,
    handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
    extras?: ClaudeSdkToolExtras,
  ): Promise<SdkMcpToolDefinition<Schema>>;
};

const defaultLoadSdk: ClaudeSdkLoader = async () => import('@anthropic-ai/claude-agent-sdk');

export class ClaudeAgentSdkService implements ClaudeAgentSdkServiceFacade {
  private readonly loadSdk: ClaudeSdkLoader;
  private readonly onLoadError: ClaudeSdkLoadErrorReporter | undefined;
  private cachedSdk: ClaudeSdkBindings | undefined;
  private inFlight: Promise<ClaudeSdkBindings> | undefined;

  public constructor(options: ClaudeAgentSdkServiceOptions = {}) {
    this.loadSdk = options.loadSdk ?? defaultLoadSdk;
    this.onLoadError = options.onLoadError;
  }

  public query(
    ...args: Parameters<ClaudeSdkBindings['query']>
  ): Promise<Awaited<ReturnType<ClaudeSdkBindings['query']>>> {
    return this.invoke('query', args);
  }

  public startup(
    ...args: Parameters<ClaudeSdkBindings['startup']>
  ): Promise<Awaited<ReturnType<ClaudeSdkBindings['startup']>>> {
    return this.invoke('startup', args);
  }

  public listSessions(
    ...args: Parameters<ClaudeSdkBindings['listSessions']>
  ): Promise<Awaited<ReturnType<ClaudeSdkBindings['listSessions']>>> {
    return this.invoke('listSessions', args);
  }

  public getSessionInfo(
    ...args: Parameters<ClaudeSdkBindings['getSessionInfo']>
  ): Promise<Awaited<ReturnType<ClaudeSdkBindings['getSessionInfo']>>> {
    return this.invoke('getSessionInfo', args);
  }

  public getSessionMessages(
    ...args: Parameters<ClaudeSdkBindings['getSessionMessages']>
  ): Promise<Awaited<ReturnType<ClaudeSdkBindings['getSessionMessages']>>> {
    return this.invoke('getSessionMessages', args);
  }

  /**
   * Read the model catalog from an initialized SDK Query without exposing the
   * Query or its initialization metadata to callers. The warm query is
   * intentionally short-lived: it is only a catalog probe and never receives
   * a user prompt.
   */
  public async listSupportedModels(cwd?: string): Promise<readonly ModelInfo[]> {
    const abortController = new AbortController();
    const options = {
      abortController,
      ...(cwd === undefined ? {} : { cwd }),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: true,
      disallowedTools: ['WebSearch'],
    } satisfies Options;

    let warmQuery: WarmQuery | undefined;
    let query: Query | undefined;
    try {
      warmQuery = await this.startup({ options });
      query = warmQuery.query(emptyUserInput(abortController.signal));

      // Newer SDKs expose supportedModels directly. The initialization result
      // is the compatibility path for SDKs that only return models there.
      if (typeof query.supportedModels === 'function') {
        return Object.freeze([...(await query.supportedModels())]);
      }
      const initialization = await query.initializationResult();
      return Object.freeze([...initialization.models]);
    } finally {
      // Query.close() is synchronous in the official SDK. Keep cleanup best
      // effort so a probe failure never replaces the useful original error.
      try {
        query?.close();
      } catch {
        // Ignore probe cleanup failures.
      }
      try {
        warmQuery?.close();
      } catch {
        // Ignore probe cleanup failures.
      }
      abortController.abort();
    }
  }

  public listSubagents(
    ...args: Parameters<ClaudeSdkBindings['listSubagents']>
  ): Promise<Awaited<ReturnType<ClaudeSdkBindings['listSubagents']>>> {
    return this.invoke('listSubagents', args);
  }

  public getSubagentMessages(
    ...args: Parameters<ClaudeSdkBindings['getSubagentMessages']>
  ): Promise<Awaited<ReturnType<ClaudeSdkBindings['getSubagentMessages']>>> {
    return this.invoke('getSubagentMessages', args);
  }

  public forkSession(
    ...args: Parameters<ClaudeSdkBindings['forkSession']>
  ): Promise<Awaited<ReturnType<ClaudeSdkBindings['forkSession']>>> {
    return this.invoke('forkSession', args);
  }

  public deleteSession(
    ...args: Parameters<ClaudeSdkBindings['deleteSession']>
  ): Promise<Awaited<ReturnType<ClaudeSdkBindings['deleteSession']>>> {
    return this.invoke('deleteSession', args);
  }

  public createSdkMcpServer(
    ...args: Parameters<ClaudeSdkBindings['createSdkMcpServer']>
  ): Promise<Awaited<ReturnType<ClaudeSdkBindings['createSdkMcpServer']>>> {
    return this.invoke('createSdkMcpServer', args);
  }

  public async tool<Schema extends AnyZodRawShape>(
    name: Parameters<ClaudeSdkBindings['tool']>[0],
    description: Parameters<ClaudeSdkBindings['tool']>[1],
    inputSchema: Schema,
    handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
    extras?: ClaudeSdkToolExtras,
  ): Promise<SdkMcpToolDefinition<Schema>> {
    const sdk = await this.getSdk();
    return sdk.tool(name, description, inputSchema, handler, extras);
  }

  private invoke<K extends ClaudeSdkBindingName>(
    name: K,
    args: Parameters<ClaudeSdkMethod<K>>,
  ): Promise<Awaited<ReturnType<ClaudeSdkMethod<K>>>> {
    return this.getSdk().then(async (sdk): Promise<Awaited<ReturnType<ClaudeSdkMethod<K>>>> => {
      const method = sdk[name] as unknown as (
        ...methodArgs: Parameters<ClaudeSdkMethod<K>>
      ) => ReturnType<ClaudeSdkMethod<K>>;
      return (await Reflect.apply(method, sdk, args)) as Awaited<ReturnType<ClaudeSdkMethod<K>>>;
    });
  }

  private getSdk(): Promise<ClaudeSdkBindings> {
    if (this.cachedSdk !== undefined) {
      return Promise.resolve(this.cachedSdk);
    }
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    const attempt = Promise.resolve()
      .then(() => this.loadSdk())
      .then(
        (sdk) => {
          this.cachedSdk = sdk;
          this.inFlight = undefined;
          return sdk;
        },
        (error: unknown) => {
          this.inFlight = undefined;
          this.reportLoadError(error);
          throw error;
        },
      );

    this.inFlight = attempt;
    return attempt;
  }

  private reportLoadError(error: unknown): void {
    const reporter = this.onLoadError;
    if (reporter === undefined) {
      return;
    }

    try {
      void Promise.resolve(reporter(error)).catch(() => undefined);
    } catch {
      // Reporter failures must not replace the loader's original rejection.
    }
  }
}

async function* emptyUserInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage, void> {
  // Keep the streaming input open while the control request is in flight. An
  // immediately completed input stream can make the CLI terminate before
  // supportedModels()/initializationResult() responds.
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
