import { describe, expect, it } from 'vitest';

import {
  ConfigurationError,
  parseAgentHostConfig,
  safeConfigSummary,
} from '../../src/server/config.js';

function validEnvironment(): Record<string, string> {
  return {
    CCVIBE_ENV: 'development',
    CCVIBE_HOST: '127.0.0.1',
    CCVIBE_PORT: '8787',
    CCVIBE_HOST_EPOCH: 'dev-epoch',
    CCVIBE_BEARER_TOKEN: 'test-token',
    CCVIBE_ALLOWED_WORKSPACES_JSON: JSON.stringify([
      {
        id: 'ccvibe',
        path: '/tmp/cloud-project',
        displayName: 'Cloud Project',
      },
    ]),
    CCVIBE_MODEL_CATALOG_JSON: JSON.stringify([
      {
        id: 'claude-sonnet',
        displayName: 'Claude Sonnet',
        capabilities: ['adaptive-thinking'],
      },
    ]),
    CCVIBE_DEFAULT_MODEL_ID: 'claude-sonnet',
  };
}

describe('agent host environment configuration', () => {
  it('parses a complete configuration into validated catalog values', () => {
    const config = parseAgentHostConfig(validEnvironment());

    expect(config).toMatchObject({
      environment: 'development',
      host: '127.0.0.1',
      port: 8787,
      hostEpoch: 'dev-epoch',
      defaultModelId: 'claude-sonnet',
      requireAuthentication: true,
    });
    expect(config.allowedWorkspaces).toEqual([
      expect.objectContaining({
        id: 'ccvibe',
        path: '/tmp/cloud-project',
        displayName: 'Cloud Project',
        status: 'available',
      }),
    ]);
    expect(config.models).toEqual([
      expect.objectContaining({
        id: 'claude-sonnet',
        displayName: 'Claude Sonnet',
        capabilities: ['adaptive-thinking'],
      }),
    ]);
    expect(safeConfigSummary(config)).not.toContain('test-token');
    expect(safeConfigSummary(config)).toContain('127.0.0.1:8787');
  });

  it('uses a loopback development default and does not enable anonymous access implicitly', () => {
    const config = parseAgentHostConfig({
      CCVIBE_HOST_EPOCH: 'dev-epoch',
      CCVIBE_BEARER_TOKEN: 'test-token',
    });

    expect(config.environment).toBe('development');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.requireAuthentication).toBe(true);
  });

  it('allows anonymous mode only with an explicit development switch', () => {
    const environment = validEnvironment();
    delete environment.CCVIBE_BEARER_TOKEN;
    environment.CCVIBE_ALLOW_ANONYMOUS_DEV = 'true';

    const config = parseAgentHostConfig(environment);

    expect(config.bearerToken).toBeUndefined();
    expect(config.requireAuthentication).toBe(false);
  });

  it('rejects production without a bearer token', () => {
    const environment = validEnvironment();
    environment.CCVIBE_ENV = 'production';
    delete environment.CCVIBE_BEARER_TOKEN;

    expect(() => parseAgentHostConfig(environment)).toThrow(ConfigurationError);
    expect(() => parseAgentHostConfig(environment)).toThrow('CCVIBE_BEARER_TOKEN');
  });

  it('rejects anonymous mode outside development', () => {
    const environment = validEnvironment();
    environment.CCVIBE_ENV = 'production';
    delete environment.CCVIBE_BEARER_TOKEN;
    environment.CCVIBE_ALLOW_ANONYMOUS_DEV = 'true';

    expect(() => parseAgentHostConfig(environment)).toThrow('development');
  });

  it('rejects a public development bind unless explicitly acknowledged', () => {
    const environment = validEnvironment();
    environment.CCVIBE_HOST = '0.0.0.0';

    expect(() => parseAgentHostConfig(environment)).toThrow('CCVIBE_ALLOW_PUBLIC_DEV');
  });

  it('accepts an explicitly configured public production bind only with authentication', () => {
    const environment = validEnvironment();
    environment.CCVIBE_ENV = 'production';
    environment.CCVIBE_HOST = '0.0.0.0';

    expect(parseAgentHostConfig(environment).host).toBe('0.0.0.0');
  });

  it('allows production catalog discovery without explicit workspace/model JSON', () => {
    const environment = validEnvironment();
    environment.CCVIBE_ENV = 'production';
    delete environment.CCVIBE_ALLOWED_WORKSPACES_JSON;
    delete environment.CCVIBE_MODEL_CATALOG_JSON;
    delete environment.CCVIBE_DEFAULT_MODEL_ID;

    const config = parseAgentHostConfig(environment);

    expect(config.allowedWorkspaces).toEqual([]);
    expect(config.models).toEqual([]);
  });

  it('requires the default model to be present in the catalog', () => {
    const environment = validEnvironment();
    environment.CCVIBE_DEFAULT_MODEL_ID = 'unknown-model';

    expect(() => parseAgentHostConfig(environment)).toThrow('CCVIBE_DEFAULT_MODEL_ID');
  });

  it('rejects duplicate workspace and model identities', () => {
    const environment = validEnvironment();
    environment.CCVIBE_ALLOWED_WORKSPACES_JSON = JSON.stringify([
      { id: 'duplicate', path: '/tmp/one', displayName: 'One' },
      { id: 'duplicate', path: '/tmp/two', displayName: 'Two' },
    ]);
    environment.CCVIBE_MODEL_CATALOG_JSON = JSON.stringify([
      { id: 'duplicate-model', displayName: 'One' },
      { id: 'duplicate-model', displayName: 'Two' },
    ]);

    expect(() => parseAgentHostConfig(environment)).toThrow('workspace');
  });

  it('does not include secret material in configuration failures', () => {
    const environment = validEnvironment();
    environment.CCVIBE_DEFAULT_MODEL_ID = 'missing-model';

    let error: unknown;
    try {
      parseAgentHostConfig(environment);
    } catch (caught) {
      error = caught;
    }

    expect(String(error)).not.toContain('test-token');
    expect(String(error)).toContain('CCVIBE_DEFAULT_MODEL_ID');
  });
});
