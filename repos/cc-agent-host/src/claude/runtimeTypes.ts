import type { UUID } from 'node:crypto';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { TurnId } from '../domain/ids.js';

export type ClaudeRuntimeState = 'starting' | 'running' | 'closing' | 'closed' | 'crashed';

export type ClaudeTurnOutcome =
  | {
      readonly status: 'completed';
      readonly resultSubtype: string;
    }
  | {
      readonly status: 'failed';
      readonly resultSubtype?: string;
      readonly message: string;
    }
  | {
      readonly status: 'interrupted';
    }
  | {
      readonly status: 'runtime_closed';
      readonly message: string;
    };

export interface ClaudeTurnHandle {
  readonly turnId: TurnId;
  readonly sdkUuid: UUID;
  readonly accepted: Promise<void>;
  readonly completed: Promise<ClaudeTurnOutcome>;
}

/** Stable, SDK-free capabilities surfaced by a runtime init signal. */
export type ClaudeRuntimeCapabilities = Readonly<Record<string, unknown>>;

/** Internal runtime signal union; it intentionally contains raw SDK messages. */
export type ClaudeRuntimeSignal =
  | {
      readonly type: 'runtime/init';
      readonly generation: number;
      readonly sdkSessionId: string;
      readonly capabilities?: ClaudeRuntimeCapabilities;
    }
  | {
      readonly type: 'runtime/message';
      readonly generation: number;
      readonly turnId?: TurnId;
      readonly phase: 'active' | 'tail' | 'unmatched';
      readonly message: SDKMessage;
    }
  | {
      readonly type: 'turn/result';
      readonly generation: number;
      readonly turnId: TurnId;
      readonly outcome: ClaudeTurnOutcome;
    }
  | {
      readonly type: 'runtime/terminal';
      readonly generation: number;
      readonly state: 'closed' | 'crashed';
      readonly error?: unknown;
    };
