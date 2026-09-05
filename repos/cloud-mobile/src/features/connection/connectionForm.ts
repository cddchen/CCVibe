import type { ConnectionMode } from '../../domain/types';
import { connectionModeFromScheme, normalizeConnectionAddress } from '../../protocol/connectionAddress';

export interface ConnectionFormValues {
  readonly hostUrl: string;
  readonly token: string;
  /**
   * Kept in the form contract for callers from the first single-Host build.
   * The settings UI no longer exposes a toggle: validation derives this
   * value from the URL scheme so a saved Host cannot drift from its address.
   */
  readonly developmentMode: boolean;
}

export interface ValidatedConnectionForm {
  readonly address: string;
  readonly mode: ConnectionMode;
  readonly token: string;
}

export interface ConnectionPreferencesProjection {
  readonly address: string;
  readonly mode: ConnectionMode;
}

export type ConnectionFormResult =
  | {
      readonly ok: true;
      readonly config: ValidatedConnectionForm;
      readonly preferences: ConnectionPreferencesProjection;
    }
  | {
      readonly ok: false;
      readonly errors: Readonly<Partial<Record<'hostUrl' | 'token', string>>>;
    };

/**
 * Derive the Host mode from the scheme the user entered.
 *
 * `http`/`ws` are the explicitly local/development transports and
 * `https`/`wss` are production transports. Unknown schemes stay undefined so
 * validation can reject them instead of silently choosing a security mode.
 */
export function deriveConnectionMode(hostUrl: string): ConnectionMode | undefined {
  return connectionModeFromScheme(hostUrl);
}

export function deriveDevelopmentMode(hostUrl: string): boolean {
  return deriveConnectionMode(hostUrl) === 'development';
}

export function validateConnectionForm(values: ConnectionFormValues): ConnectionFormResult {
  const mode = deriveConnectionMode(values.hostUrl);
  const errors: Partial<Record<'hostUrl' | 'token', string>> = {};
  let address: string | undefined;

  if (values.hostUrl.trim().length === 0) {
    errors.hostUrl = '请输入 Host URL';
  } else if (mode === undefined) {
    errors.hostUrl = '请输入以 ws://、wss://、http:// 或 https:// 开头的 Host URL';
  } else {
    try {
      address = normalizeConnectionAddress(values.hostUrl, mode);
    } catch {
      errors.hostUrl = mode === 'production' && isInsecureAddress(values.hostUrl)
        ? '生产 Host 仅支持 https:// 或 wss:// 地址'
        : '请输入有效的 Host URL';
    }
  }

  if (values.token.trim().length === 0) {
    errors.token = '请输入 Token，或使用已保存的 Token';
  }

  if (Object.keys(errors).length > 0 || address === undefined || mode === undefined) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }

  const config = Object.freeze({ address, mode, token: values.token.trim() });
  return Object.freeze({
    ok: true,
    config,
    preferences: Object.freeze({ address, mode }),
  });
}

function isInsecureAddress(value: string): boolean {
  return /^\s*(?:http|ws):/iu.test(value);
}
