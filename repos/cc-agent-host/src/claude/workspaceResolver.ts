import { realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute } from 'node:path';

import type { CatalogWorkspace } from '../catalog/types.js';
import {
  WORKSPACE_RESOLVE_ERROR_CODES,
  WorkspaceResolverError,
} from '../catalog/workspaceResolver.js';
import { projectCatalogWorkspace } from './catalogSource.js';

/** Narrow filesystem port used by the resolver and its deterministic tests. */
export interface WorkspaceFilesystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Pick<Stats, 'isDirectory'>>;
}

export interface FilesystemWorkspaceResolver {
  resolveWorkspace(path: string): Promise<CatalogWorkspace>;
}

/**
 * Resolve one user-entered path against the Agent Host's real filesystem.
 *
 * `realpath` is intentionally performed before `stat`: the returned catalog
 * path and stable workspace id describe the canonical target rather than a
 * symlink alias. No directory is created and no successful result is returned
 * for an inaccessible, missing, or non-directory path.
 */
export function createFilesystemWorkspaceResolver(
  filesystem: WorkspaceFilesystem = { realpath, stat },
): FilesystemWorkspaceResolver {
  return Object.freeze({
    resolveWorkspace: async (path: string): Promise<CatalogWorkspace> => {
      assertAbsoluteWorkspacePath(path);

      let canonicalPath: string;
      try {
        canonicalPath = await filesystem.realpath(path);
      } catch (error) {
        throw mapFilesystemError(error);
      }

      let metadata: Pick<Stats, 'isDirectory'>;
      try {
        metadata = await filesystem.stat(canonicalPath);
      } catch (error) {
        throw mapFilesystemError(error);
      }

      if (!metadata.isDirectory()) {
        throw new WorkspaceResolverError(WORKSPACE_RESOLVE_ERROR_CODES.notDirectory);
      }

      try {
        return projectCatalogWorkspace(canonicalPath);
      } catch {
        // A platform-specific realpath result that cannot be represented by
        // the protocol must never become an untyped internal error.
        throw new WorkspaceResolverError(WORKSPACE_RESOLVE_ERROR_CODES.invalidPath);
      }
    },
  });
}

/** Convenience entry point for callers that do not need the object port. */
export async function resolveFilesystemWorkspace(path: string): Promise<CatalogWorkspace> {
  return createFilesystemWorkspaceResolver().resolveWorkspace(path);
}

function assertAbsoluteWorkspacePath(path: string): void {
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) {
    throw new WorkspaceResolverError(WORKSPACE_RESOLVE_ERROR_CODES.invalidPath);
  }
}

function mapFilesystemError(error: unknown): WorkspaceResolverError {
  const code = typeof error === 'object' && error !== null
    ? (error as { readonly code?: unknown }).code
    : undefined;
  if (code === 'ENOENT') {
    return new WorkspaceResolverError(WORKSPACE_RESOLVE_ERROR_CODES.notFound);
  }
  if (code === 'ENOTDIR') {
    return new WorkspaceResolverError(WORKSPACE_RESOLVE_ERROR_CODES.notDirectory);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new WorkspaceResolverError(WORKSPACE_RESOLVE_ERROR_CODES.accessDenied);
  }
  if (code === 'EINVAL' || code === 'EILSEQ') {
    return new WorkspaceResolverError(WORKSPACE_RESOLVE_ERROR_CODES.invalidPath);
  }
  return new WorkspaceResolverError(WORKSPACE_RESOLVE_ERROR_CODES.failed);
}
