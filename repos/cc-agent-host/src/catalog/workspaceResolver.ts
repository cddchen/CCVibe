/** Stable, client-facing failures produced while resolving a workspace path. */
export const WORKSPACE_RESOLVE_ERROR_CODES = Object.freeze({
  invalidPath: 'WORKSPACE_PATH_INVALID',
  notFound: 'WORKSPACE_NOT_FOUND',
  notDirectory: 'WORKSPACE_NOT_DIRECTORY',
  accessDenied: 'WORKSPACE_ACCESS_DENIED',
  failed: 'WORKSPACE_RESOLVE_FAILED',
} as const);

export type WorkspaceResolveErrorCode =
  (typeof WORKSPACE_RESOLVE_ERROR_CODES)[keyof typeof WORKSPACE_RESOLVE_ERROR_CODES];

const WORKSPACE_RESOLVE_ERROR_MESSAGES: Readonly<Record<WorkspaceResolveErrorCode, string>> = Object.freeze({
  WORKSPACE_PATH_INVALID: 'workspace path is invalid',
  WORKSPACE_NOT_FOUND: 'workspace path was not found',
  WORKSPACE_NOT_DIRECTORY: 'workspace path is not a directory',
  WORKSPACE_ACCESS_DENIED: 'workspace path cannot be accessed',
  WORKSPACE_RESOLVE_FAILED: 'workspace path could not be resolved',
});

function isWorkspaceResolveErrorCode(value: unknown): value is WorkspaceResolveErrorCode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(WORKSPACE_RESOLVE_ERROR_MESSAGES, value);
}

/**
 * Error type shared by the filesystem composition and protocol adapter.
 *
 * Only the stable code is serialized to a client. Filesystem errors, paths,
 * and platform-specific messages stay inside the host process.
 */
export class WorkspaceResolverError extends Error {
  public readonly code: WorkspaceResolveErrorCode;

  public constructor(code: WorkspaceResolveErrorCode) {
    const safeCode = isWorkspaceResolveErrorCode(code)
      ? code
      : WORKSPACE_RESOLVE_ERROR_CODES.failed;
    super(WORKSPACE_RESOLVE_ERROR_MESSAGES[safeCode]);
    this.name = 'WorkspaceResolverError';
    this.code = safeCode;
  }
}
