import { createHash, timingSafeEqual } from 'node:crypto';

import { createClaudeAgentHost, type ClaudeAgentHost } from '../claude/createClaudeAgentHost.js';
import type { BearerToken } from '../security/identity.js';
import type {
  BearerTokenVerifier,
  BearerVerificationContext,
} from '../transport/auth.js';
import {
  formatHostPort,
  loadAgentHostConfig,
  type AgentHostServerConfig,
} from './config.js';

export type { AgentHostServerConfig } from './config.js';
export { ConfigurationError, formatHostPort, loadAgentHostConfig, parseAgentHostConfig, safeConfigSummary } from './config.js';

export interface AgentHostListenAddress {
  readonly host: string;
  readonly port: number;
}

export interface AgentHostLifecycle {
  readonly server: {
    listen(address: AgentHostListenAddress): PromiseLike<unknown>;
  };
  refreshCatalog(): PromiseLike<unknown>;
  shutdown(): PromiseLike<void>;
}

export interface RunningAgentHost extends AgentHostLifecycle {
  readonly config: AgentHostServerConfig;
  close(): Promise<void>;
}

export interface AgentHostStartupDependencies {
  readonly createHost?: (config: AgentHostServerConfig) => PromiseLike<AgentHostLifecycle>;
}

/**
 * Compare fixed-size digests so token length is not reflected in the verifier
 * operation. The raw credential remains inside this closure and never enters
 * a URL, response, action, or log line.
 */
export function createStaticBearerTokenVerifier(
  expected: BearerToken,
): BearerTokenVerifier<true> {
  const expectedDigest = digestToken(expected);
  return (received: BearerToken, _context: BearerVerificationContext): true | undefined =>
    timingSafeEqual(expectedDigest, digestToken(received)) ? true : undefined;
}

/** Start a host in a deterministic refresh-before-listen order. */
export async function startAgentHostFromConfig(
  config: AgentHostServerConfig,
  dependencies: AgentHostStartupDependencies = {},
): Promise<RunningAgentHost> {
  const createHost = dependencies.createHost ?? createConfiguredHost;
  let host: AgentHostLifecycle | undefined;
  try {
    host = await createHost(config);
    await host.refreshCatalog();
    await host.server.listen({ host: config.host, port: config.port });
  } catch (error) {
    if (host !== undefined) {
      await Promise.resolve(host.shutdown()).catch(() => undefined);
    }
    throw error;
  }

  const startedHost = host;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise === undefined) {
      closePromise = Promise.resolve().then(() => startedHost.shutdown()).then(() => undefined);
    }
    return closePromise;
  };

  return {
    ...startedHost,
    config,
    close,
  };
}

export interface SignalProcessLike {
  exitCode: number | string | null | undefined;
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown;
}

/** Install idempotent SIGINT/SIGTERM handlers and return a disposer for tests. */
export function installGracefulShutdown(
  running: Pick<RunningAgentHost, 'close'>,
  processLike: SignalProcessLike = process,
  onError: (error: unknown) => void = () => undefined,
): () => void {
  let closePromise: Promise<void> | undefined;
  let disposed = false;
  const onSignal = (): void => {
    if (closePromise !== undefined) {
      return;
    }
    closePromise = Promise.resolve().then(() => running.close()).catch((error: unknown) => {
      processLike.exitCode = 1;
      try {
        onError(error);
      } catch {
        // Reporting must not create an unhandled rejection during shutdown.
      }
    }).then(() => undefined);
    void closePromise.finally(() => {
      removeHandlers();
    });
  };
  const removeHandlers = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    processLike.removeListener('SIGINT', onSignal);
    processLike.removeListener('SIGTERM', onSignal);
  };

  processLike.once('SIGINT', onSignal);
  processLike.once('SIGTERM', onSignal);
  return removeHandlers;
}

export interface StartedAgentHost {
  readonly config: AgentHostServerConfig;
  readonly running: RunningAgentHost;
  readonly disposeSignals: () => void;
}

/** Load process configuration, start the server, and attach signal cleanup. */
export async function runAgentHostCli(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  processLike: SignalProcessLike = process,
): Promise<StartedAgentHost> {
  const config = loadAgentHostConfig(environment);
  const running = await startAgentHostFromConfig(config);
  const disposeSignals = installGracefulShutdown(running, processLike, () => undefined);
  return { config, running, disposeSignals };
}

/** CLI-safe top-level error boundary; no lower-level error text is logged. */
export async function main(): Promise<void> {
  try {
    const started = await runAgentHostCli();
    process.stdout.write(`Cloud Agent Host listening on ${formatHostPort(started.config.host, started.config.port)}\n`);
  } catch (error) {
    process.exitCode = 1;
    const message = error instanceof Error && error.name === 'ConfigurationError'
      ? error.message
      : 'server startup failed; inspect configuration and deployment logs';
    process.stderr.write(`Cloud Agent Host startup failed: ${message}\n`);
  }
}

async function createConfiguredHost(config: AgentHostServerConfig): Promise<AgentHostLifecycle> {
  const bearerToken = config.bearerToken;
  const host = await createClaudeAgentHost({
    hostEpoch: config.hostEpoch,
    nowServer: () => new Date().toISOString(),
    nowAction: () => new Date().toISOString(),
    catalog: {
      ...(config.allowedWorkspaces.length === 0 ? {} : { workspaces: config.allowedWorkspaces }),
      ...(config.models.length === 0 ? {} : { models: config.models }),
      ...(config.defaultModelId === undefined ? {} : { defaultModelId: config.defaultModelId }),
    },
    server: {
      fastifyOptions: { logger: config.environment === 'production' },
      ...(bearerToken === undefined
        ? { requireAuthentication: false }
        : {
            authentication: {
              required: true,
              verifier: createStaticBearerTokenVerifier(bearerToken),
            },
          }),
    },
  });
  return adaptClaudeHost(host);
}

function adaptClaudeHost(host: ClaudeAgentHost): AgentHostLifecycle {
  return {
    server: {
      listen: (address) => host.server.listen(address),
    },
    refreshCatalog: () => host.refreshCatalog(),
    shutdown: () => host.shutdown(),
  };
}

function digestToken(token: BearerToken): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
