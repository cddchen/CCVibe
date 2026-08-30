import { describe, expect, it } from 'vitest';

import { createBearerToken } from '../../src/security/identity.js';
import {
  createStaticBearerTokenVerifier,
  installGracefulShutdown,
  startAgentHostFromConfig,
  type AgentHostLifecycle,
  type AgentHostServerConfig,
  type SignalProcessLike,
} from '../../src/server/start.js';

function config(): AgentHostServerConfig {
  return {
    environment: 'development',
    host: '127.0.0.1',
    port: 8787,
    hostEpoch: 'dev-epoch',
    bearerToken: createBearerToken('test-token'),
    requireAuthentication: true,
    allowAnonymousDev: false,
    allowedWorkspaces: [],
    models: [],
  };
}

function lifecycle(calls: string[]): AgentHostLifecycle {
  return {
    refreshCatalog: async () => {
      calls.push('refreshCatalog');
    },
    server: {
      listen: async (address) => {
        calls.push(`listen:${address.host}:${address.port}`);
      },
    },
    shutdown: async () => {
      calls.push('shutdown');
    },
  };
}

describe('agent host startup orchestration', () => {
  it('refreshes the catalog before listening and makes close idempotent', async () => {
    const calls: string[] = [];
    const running = await startAgentHostFromConfig(config(), {
      createHost: async () => lifecycle(calls),
    });

    expect(calls).toEqual(['refreshCatalog', 'listen:127.0.0.1:8787']);

    await running.close();
    await running.close();

    expect(calls).toEqual([
      'refreshCatalog',
      'listen:127.0.0.1:8787',
      'shutdown',
    ]);
  });

  it('shuts down a constructed host when refresh fails', async () => {
    const calls: string[] = [];
    const host = lifecycle(calls);
    const failingHost: AgentHostLifecycle = {
      ...host,
      refreshCatalog: async () => {
        calls.push('refreshCatalog');
        throw new Error('refresh failed');
      },
    };

    await expect(startAgentHostFromConfig(config(), {
      createHost: async () => failingHost,
    })).rejects.toThrow('refresh failed');
    expect(calls).toEqual(['refreshCatalog', 'shutdown']);
  });

  it('shuts down a constructed host when listen fails', async () => {
    const calls: string[] = [];
    const host = lifecycle(calls);
    const failingHost: AgentHostLifecycle = {
      ...host,
      server: {
        listen: async () => {
          calls.push('listen');
          throw new Error('listen failed');
        },
      },
    };

    await expect(startAgentHostFromConfig(config(), {
      createHost: async () => failingHost,
    })).rejects.toThrow('listen failed');
    expect(calls).toEqual(['refreshCatalog', 'listen', 'shutdown']);
  });

  it('compares bearer tokens without putting the credential in a result', async () => {
    const verify = createStaticBearerTokenVerifier(createBearerToken('test-token'));

    expect(verify(createBearerToken('test-token'), {
      transport: 'websocket',
    })).toBe(true);
    expect(verify(createBearerToken('wrong-token'), {
      transport: 'websocket',
    })).toBeUndefined();
  });
});

class FakeSignalProcess implements SignalProcessLike {
  public exitCode: number | string | null | undefined = undefined;
  private readonly listeners = new Map<string, () => void>();

  public once(signal: NodeJS.Signals, listener: () => void): this {
    this.listeners.set(signal, listener);
    return this;
  }

  public removeListener(signal: NodeJS.Signals, listener: () => void): this {
    if (this.listeners.get(signal) === listener) {
      this.listeners.delete(signal);
    }
    return this;
  }

  public emit(signal: NodeJS.Signals): void {
    this.listeners.get(signal)?.();
  }
}

describe('graceful shutdown signals', () => {
  it('handles SIGINT and SIGTERM once and removes both handlers', async () => {
    const processLike = new FakeSignalProcess();
    let shutdownCalls = 0;
    const dispose = installGracefulShutdown({
      close: async () => {
        shutdownCalls += 1;
      },
    }, processLike);

    processLike.emit('SIGINT');
    processLike.emit('SIGTERM');
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdownCalls).toBe(1);

    dispose();
    processLike.emit('SIGINT');
    expect(shutdownCalls).toBe(1);
  });

  it('marks process failure when graceful close rejects', async () => {
    const processLike = new FakeSignalProcess();
    installGracefulShutdown({
      close: async () => {
        throw new Error('close failed');
      },
    }, processLike);

    processLike.emit('SIGTERM');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(processLike.exitCode).toBe(1);
  });
});
