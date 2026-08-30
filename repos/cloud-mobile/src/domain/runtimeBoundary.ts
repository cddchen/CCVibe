import type { TurnStartedAction } from './types';
import { createTurnId } from '../protocol/ids';

export type ClientPlatform = 'ios' | 'android' | 'web' | 'unknown';

export interface RuntimeDependencies {
  readonly now: () => string;
  readonly createId: () => string;
  readonly platform: ClientPlatform;
}

export function createTurnStartedAction(
  dependencies: RuntimeDependencies,
  prompt: string,
): TurnStartedAction {
  const action: TurnStartedAction = Object.freeze({
    type: 'chat/turnStarted',
    turnId: createTurnId(dependencies.createId()),
    prompt,
    timestamp: dependencies.now(),
  });
  return action;
}
