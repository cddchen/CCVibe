import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { SystemMessage, SystemMessageLevel } from '../domain/chat.js';
import { redactStructuredLog } from '../security/redaction.js';

type ClaudeSystemMessage = Extract<SDKMessage, { readonly type: 'system' }>;
type ClaudeSystemSubtype = ClaudeSystemMessage['subtype'];
type BackgroundTaskEvent = 'task_notification' | 'task_progress' | 'task_started' | 'task_updated';
type ClaudeBackgroundTaskMessage = Extract<ClaudeSystemMessage, { readonly subtype: BackgroundTaskEvent }>;

/**
 * Claude-layer-only metadata used to coalesce background task edge events.
 * `taskId` is deliberately removed before a domain action is built so it can
 * never become part of the public response-part or wire shape.
 */
interface ClaudeSystemMessageProjection extends SystemMessage {
  readonly taskId?: string;
}

const MAX_SYSTEM_CONTENT_LENGTH = 24_000;
const MAX_COMPACT_ERROR_LENGTH = 4_000;
const OMITTED_FIELDS = new Set(['type', 'subtype', 'uuid', 'session_id', 'task_id']);
const SENSITIVE_FIELD = /^(?:authorization|proxy_authorization|cookie|set_cookie|bearer|access_token|refresh_token|id_token|secret|password|credentials?|api_key|apikey|private_key|client_secret)$/iu;

const SYSTEM_TITLES = {
  api_retry: 'API 请求重试',
  background_tasks_changed: '后台任务变化',
  commands_changed: '命令列表变化',
  compact_boundary: '上下文压缩',
  control_request_progress: '控制请求进度',
  elicitation_complete: '外部输入已完成',
  files_persisted: '文件已保存',
  hook_progress: 'Hook 执行中',
  hook_response: 'Hook 执行结果',
  hook_started: 'Hook 已启动',
  informational: '系统提示',
  init: '运行环境初始化',
  local_command_output: '命令输出',
  memory_recall: '已读取记忆',
  mirror_error: '会话同步错误',
  model_refusal_fallback: '模型已回退',
  model_refusal_no_fallback: '模型拒绝响应',
  notification: '系统通知',
  permission_denied: '工具权限被拒绝',
  plugin_install: '插件安装',
  session_state_changed: '会话状态变化',
  status: '运行状态',
  task_notification: '后台任务结果',
  task_progress: '后台任务进度',
  task_started: '后台任务已启动',
  task_updated: '后台任务已更新',
  thinking_tokens: '思考进度',
  worker_shutting_down: '运行进程即将关闭',
} satisfies Record<ClaudeSystemSubtype, string>;

/** Convert a live SDK event into the stable, textual domain projection. */
export function projectClaudeSystemMessage(message: ClaudeSystemMessage): ClaudeSystemMessageProjection | undefined {
  // Keep the live path tied to the installed SDK union: task_id is an
  // official field on each of the four edge message variants, not an ad-hoc
  // field copied into a parallel provider type.
  const taskId = isBackgroundTaskMessage(message) ? message.task_id : undefined;
  return projectSystemRecord(message, taskId);
}

/** Convert a transcript system payload without trusting its SDK-private shape. */
export function projectRecordedSystemMessage(value: unknown): ClaudeSystemMessageProjection | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return projectSystemRecord(value);
}

function projectSystemRecord(record: object, taskIdOverride?: string): ClaudeSystemMessageProjection | undefined {
  const event = readString(record, 'subtype');
  if (event === undefined || event.length === 0) {
    return undefined;
  }
  // SDK init carries runtime/catalog metadata. It is consumed by the Host
  // control plane and must never become a transcript response part in either
  // the live or replay projection.
  if (event === 'init') {
    return undefined;
  }
  if (event === 'status') {
    const compactResult = readString(record, 'compact_result');
    const compactError = readString(record, 'compact_error');
    if (compactResult !== 'failed' && compactError === undefined) return undefined;
    return Object.freeze({
      event: 'compact_error',
      title: '上下文压缩失败',
      content: clipText(redactStructuredLog(compactError ?? '上下文压缩失败。'), MAX_COMPACT_ERROR_LENGTH),
      level: 'error',
    });
  }
  const projection = {
    event,
    title: titleFor(event),
    content: clipContent(redactStructuredLog(contentFor(record, event))),
    level: levelFor(record, event),
  } satisfies SystemMessage;
  const taskId = isBackgroundTaskEvent(event) ? taskIdOverride ?? readString(record, 'task_id') : undefined;
  return taskId === undefined || taskId.length === 0
    ? Object.freeze(projection)
    : Object.freeze({ ...projection, taskId });
}

function titleFor(event: string): string {
  if (isBackgroundTaskEvent(event)) {
    return '后台任务进度';
  }
  return Object.entries(SYSTEM_TITLES).find(([candidate]) => candidate === event)?.[1]
    ?? `系统事件 · ${event}`;
}

function contentFor(record: object, event: string): string {
  switch (event) {
    case 'informational':
    case 'local_command_output':
    case 'model_refusal_fallback':
    case 'model_refusal_no_fallback':
      return readString(record, 'content') ?? detailsFor(record);
    case 'notification':
      return readString(record, 'text') ?? detailsFor(record);
    case 'permission_denied':
      return joinNonEmpty([
        readString(record, 'tool_name'),
        readString(record, 'decision_reason'),
        readString(record, 'message'),
      ]) ?? detailsFor(record);
    case 'mirror_error':
      return readString(record, 'error') ?? detailsFor(record);
    case 'hook_progress':
    case 'hook_response':
      return joinNonEmpty([
        readString(record, 'output'),
        readString(record, 'stdout'),
        readString(record, 'stderr'),
      ]) ?? detailsFor(record);
    case 'task_notification':
      return joinNonEmpty([
        readString(record, 'summary'),
        readString(record, 'output_file'),
      ]) ?? detailsFor(record);
    case 'task_progress':
      return joinNonEmpty([
        readString(record, 'description'),
        readString(record, 'summary'),
        readString(record, 'last_tool_name'),
      ]) ?? detailsFor(record);
    case 'task_started':
      return joinNonEmpty([
        readString(record, 'description'),
        readString(record, 'workflow_name'),
      ]) ?? detailsFor(record);
    case 'worker_shutting_down':
      return readString(record, 'reason') ?? detailsFor(record);
    default:
      return detailsFor(record);
  }
}

function levelFor(record: object, event: string): SystemMessageLevel {
  if (event === 'informational') {
    const level = readString(record, 'level');
    return level === 'warning' ? 'warning' : 'info';
  }
  if (event === 'mirror_error' || event === 'model_refusal_no_fallback') {
    return 'error';
  }
  if (event === 'hook_response') {
    const outcome = readString(record, 'outcome');
    return outcome === 'error' ? 'error' : outcome === 'success' ? 'success' : 'warning';
  }
  if (event === 'plugin_install') {
    const status = readString(record, 'status');
    return status === 'failed' ? 'error' : status === 'installed' || status === 'completed' ? 'success' : 'progress';
  }
  if (event === 'task_notification') {
    const status = readString(record, 'status');
    return status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'warning';
  }
  if (event === 'status') {
    const compactResult = readString(record, 'compact_result');
    return compactResult === 'failed' ? 'error' : compactResult === 'success' ? 'success' : 'progress';
  }
  if (event === 'notification') {
    const priority = readString(record, 'priority');
    return priority === 'high' || priority === 'immediate' ? 'warning' : 'info';
  }
  if (event === 'session_state_changed' && readString(record, 'state') === 'requires_action') {
    return 'warning';
  }
  if (event === 'api_retry' || event === 'permission_denied') {
    return 'warning';
  }
  if (event === 'compact_boundary' || event === 'elicitation_complete' || event === 'files_persisted') {
    return 'success';
  }
  if (
    event === 'control_request_progress'
    || event === 'hook_started'
    || event === 'hook_progress'
    || event === 'session_state_changed'
    || event === 'task_started'
    || event === 'task_progress'
    || event === 'task_updated'
    || event === 'background_tasks_changed'
    || event === 'thinking_tokens'
  ) {
    return 'progress';
  }
  return 'info';
}

function isBackgroundTaskEvent(event: string): event is BackgroundTaskEvent {
  return event === 'task_notification'
    || event === 'task_progress'
    || event === 'task_started'
    || event === 'task_updated';
}

function isBackgroundTaskMessage(message: ClaudeSystemMessage): message is ClaudeBackgroundTaskMessage {
  return isBackgroundTaskEvent(message.subtype);
}

function detailsFor(record: object): string {
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (OMITTED_FIELDS.has(key)) continue;
    details[key] = SENSITIVE_FIELD.test(key) ? '[REDACTED]' : value;
  }
  if (Object.keys(details).length === 0) {
    return '系统事件未提供详细信息。';
  }
  try {
    // Serialize first, then redact the resulting text at the outer boundary.
    // Structured-log key redaction would incorrectly hide harmless metrics
    // such as pre_tokens and estimated_tokens from the user-facing event.
    return JSON.stringify(details, jsonReplacer, 2) ?? '系统事件未提供详细信息。';
  } catch {
    return '系统事件详细信息无法显示。';
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return '[不可序列化]';
  return value;
}

function readString(record: object, key: string): string | undefined {
  const value: unknown = Reflect.get(record, key);
  return typeof value === 'string' ? value : undefined;
}

function joinNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  const content = values.map((value) => value?.trim()).filter((value): value is string => value !== undefined && value.length > 0);
  return content.length === 0 ? undefined : content.join('\n');
}

function clipContent(value: string): string {
  return clipText(value, MAX_SYSTEM_CONTENT_LENGTH);
}

function clipText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}
