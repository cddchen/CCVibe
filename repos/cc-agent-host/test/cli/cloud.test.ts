import { describe, expect, it } from 'vitest';

import { CloudCliError, createSixDigitToken, parseCloudCli } from '../../src/cli/cloud.js';

const parseOptions = {
  defaultLanHost: () => '192.168.12.34',
  tokenGenerator: () => '012345',
};

describe('cloud CLI', () => {
  it('starts in the background on the LAN and generates a six-digit token by default', () => {
    const parsed = parseCloudCli(['start'], { PRESERVED: 'value' }, parseOptions);

    expect(parsed).toEqual({
      command: 'start',
      background: true,
      generatedToken: '012345',
      environment: expect.objectContaining({
        CCVIBE_HOST: '192.168.12.34',
        CCVIBE_BEARER_TOKEN: '012345',
        PRESERVED: 'value',
      }),
    });
  });

  it('uses a caller-supplied token and network options without generating a replacement', () => {
    const parsed = parseCloudCli([
      'start',
      '--token=cli-token',
      '--host', '0.0.0.0',
      '--port=9000',
      '--env', 'development',
    ], {
      CCVIBE_BEARER_TOKEN: 'environment-token',
    }, parseOptions);

    expect(parsed).toEqual({
      command: 'start',
      background: true,
      environment: expect.objectContaining({
        CCVIBE_BEARER_TOKEN: 'cli-token',
        CCVIBE_HOST: '0.0.0.0',
        CCVIBE_PORT: '9000',
        CCVIBE_ENV: 'development',
        CCVIBE_ALLOW_PUBLIC_DEV: 'true',
      }),
    });
    expect(parsed).not.toHaveProperty('generatedToken');
  });

  it('uses --global to bind 0.0.0.0 without requiring a separate environment variable', () => {
    const parsed = parseCloudCli(['start', '--global'], {}, parseOptions);

    expect(parsed).toEqual({
      command: 'start',
      background: true,
      generatedToken: '012345',
      environment: expect.objectContaining({
        CCVIBE_HOST: '0.0.0.0',
        CCVIBE_ALLOW_PUBLIC_DEV: 'true',
      }),
    });
  });

  it('keeps a configured environment token and supports foreground operation', () => {
    const parsed = parseCloudCli(['start', '--foreground'], {
      CCVIBE_BEARER_TOKEN: 'environment-token',
    }, parseOptions);

    expect(parsed).toEqual({
      command: 'start',
      background: false,
      environment: expect.objectContaining({
        CCVIBE_BEARER_TOKEN: 'environment-token',
        CCVIBE_HOST: '192.168.12.34',
      }),
    });
    expect(parsed).not.toHaveProperty('generatedToken');
  });

  it('provides lifecycle commands without parsing a token', () => {
    expect(parseCloudCli(['stop'])).toEqual({ command: 'stop' });
    expect(parseCloudCli(['status'])).toEqual({ command: 'status' });
    expect(parseCloudCli([])).toEqual({ command: 'help' });
  });

  it('rejects conflicting, unknown, and value-less arguments without exposing tokens', () => {
    expect(() => parseCloudCli(['start', '--global', '--host', '127.0.0.1']))
      .toThrow('--global cannot be used with --host');
    expect(() => parseCloudCli(['stop', '--force'])).toThrow('stop does not accept options');
    expect(() => parseCloudCli(['start', '--token'])).toThrow('--token requires a non-empty value');

    let error: unknown;
    try {
      parseCloudCli(['start', '--token=secret', '--unknown=value']);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CloudCliError);
    expect(String(error)).toContain('--unknown');
    expect(String(error)).not.toContain('secret');
  });

  it('creates six-digit tokens including leading zeroes when needed', () => {
    expect(createSixDigitToken()).toMatch(/^\d{6}$/u);
  });
});
