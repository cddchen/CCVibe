import { describe, expect, it } from 'vitest';

import {
  validateConnectionForm,
  type ConnectionFormValues,
} from '../src/features/connection/connectionForm';

const validForm: ConnectionFormValues = {
  hostUrl: 'https://host.example.test/agent',
  token: 'secret-token',
  developmentMode: false,
};

describe('connection form validation', () => {
  it('normalizes secure production hosts and never includes a token in the preferences projection', () => {
    const result = validateConnectionForm(validForm);

    if (!result.ok) {
      throw new Error('expected a valid connection form');
    }

    expect(result).toEqual({
      ok: true,
      config: {
        address: 'wss://host.example.test/agent',
        mode: 'production',
        token: 'secret-token',
      },
      preferences: {
        address: 'wss://host.example.test/agent',
        mode: 'production',
      },
    });
    expect(JSON.stringify(result.preferences)).not.toContain('secret-token');
  });

  it('derives development mode from ws/http schemes regardless of the legacy toggle field', () => {
    expect(validateConnectionForm({
      ...validForm,
      hostUrl: 'ws://localhost:8787/agent',
    })).toMatchObject({
      ok: true,
      config: { address: 'ws://localhost:8787/agent', mode: 'development' },
    });

    expect(validateConnectionForm({
      ...validForm,
      hostUrl: 'ws://localhost:8787/agent',
      developmentMode: false,
    })).toMatchObject({
      ok: true,
      config: { address: 'ws://localhost:8787/agent', mode: 'development' },
    });

    expect(validateConnectionForm({
      ...validForm,
      hostUrl: 'https://cloud.example.test/agent',
      developmentMode: true,
    })).toMatchObject({
      ok: true,
      config: { address: 'wss://cloud.example.test/agent', mode: 'production' },
    });
  });

  it('reports required fields without echoing sensitive input', () => {
    const result = validateConnectionForm({
      hostUrl: 'not a url',
      token: 'sensitive-token',
      developmentMode: false,
    });

    expect(result).toMatchObject({
      ok: false,
      errors: { hostUrl: '请输入以 ws://、wss://、http:// 或 https:// 开头的 Host URL' },
    });
    expect(JSON.stringify(result)).not.toContain('sensitive-token');
  });
});
