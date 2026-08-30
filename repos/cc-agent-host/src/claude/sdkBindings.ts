export type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

export type ClaudeSdkBindingName =
  | 'query'
  | 'startup'
  | 'listSessions'
  | 'getSessionInfo'
  | 'getSessionMessages'
  | 'listSubagents'
  | 'getSubagentMessages'
  | 'forkSession'
  | 'deleteSession'
  | 'createSdkMcpServer'
  | 'tool';

export type ClaudeSdkBindings = Pick<ClaudeSdkModule, ClaudeSdkBindingName>;

const claudeSdkBindingNames = [
  'query',
  'startup',
  'listSessions',
  'getSessionInfo',
  'getSessionMessages',
  'listSubagents',
  'getSubagentMessages',
  'forkSession',
  'deleteSession',
  'createSdkMcpServer',
  'tool',
] as const satisfies readonly ClaudeSdkBindingName[];

type Assert<T extends true> = T;
type BindingKeysExist = ClaudeSdkBindingName extends keyof ClaudeSdkModule ? true : false;
type BindingNamesAreExact =
  Exclude<ClaudeSdkBindingName, (typeof claudeSdkBindingNames)[number]> extends never
    ? Exclude<(typeof claudeSdkBindingNames)[number], ClaudeSdkBindingName> extends never
      ? true
      : false
    : false;
type BindingSliceIsAssignable = {
  [K in ClaudeSdkBindingName]: ClaudeSdkBindings[K] extends ClaudeSdkModule[K]
    ? ClaudeSdkModule[K] extends ClaudeSdkBindings[K]
      ? true
      : false
    : false;
}[ClaudeSdkBindingName];

export type ClaudeSdkBindingAssertions = [
  Assert<BindingKeysExist>,
  Assert<BindingNamesAreExact>,
  Assert<BindingSliceIsAssignable>,
];
