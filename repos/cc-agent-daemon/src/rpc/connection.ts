export type ClientConnection = {
  id: string;
  send: (payload: unknown) => void;
  close: () => void;
  authenticated: boolean;
  /** Last connection used for permission prompts on this session */
  permissionClientId?: string;
};

export function createConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}