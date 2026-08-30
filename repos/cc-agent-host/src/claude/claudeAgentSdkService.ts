import type {
  AnyZodRawShape,
  InferShape,
  SdkMcpToolDefinition,
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
