import type { ConnectionMode } from '../../domain/types';
import { normalizeConnectionAddress } from '../../protocol/connectionAddress';

export interface ConnectionFormValues {
  readonly hostUrl: string;
  readonly token: string;
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

export function validateConnectionForm(values: ConnectionFormValues): ConnectionFormResult {
  const mode: ConnectionMode = values.developmentMode ? 'development' : 'production';
  const errors: Partial<Record<'hostUrl' | 'token', string>> = {};
  let address: string | undefined;

  if (values.hostUrl.trim().length === 0) {
    errors.hostUrl = '请输入 Host URL';
  } else {
    try {
      address = normalizeConnectionAddress(values.hostUrl, mode);
    } catch {
      errors.hostUrl = values.developmentMode
        ? '请输入有效的 Host URL'
        : isInsecureAddress(values.hostUrl)
          ? '生产模式仅支持 https:// 或 wss:// 地址'
          : '请输入有效的 Host URL';
    }
  }

  if (values.token.trim().length === 0) {
    errors.token = '请输入 Token，或使用已保存的 Token';
  }

  if (Object.keys(errors).length > 0 || address === undefined) {
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
