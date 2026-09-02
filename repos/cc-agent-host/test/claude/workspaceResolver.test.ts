import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createFilesystemWorkspaceResolver,
  projectCatalogWorkspace,
  WorkspaceResolverError,
} from '../../src/index.js';

describe('filesystem workspace resolver', () => {
  it('canonicalizes an existing directory and uses the catalog workspace projection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ccvibe-workspace-'));
    try {
      const resolver = createFilesystemWorkspaceResolver();
      const workspace = await resolver.resolveWorkspace(`${directory}/.`);

      expect(workspace).toEqual(projectCatalogWorkspace(await realpath(directory)));
      expect(workspace.status).toBe('available');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a real path that is not a directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ccvibe-workspace-'));
    const file = join(directory, 'file.txt');
    await writeFile(file, 'content');
    try {
      await expect(createFilesystemWorkspaceResolver().resolveWorkspace(file))
        .rejects.toMatchObject({
          name: 'WorkspaceResolverError',
          code: 'WORKSPACE_NOT_DIRECTORY',
        });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['ENOENT', 'WORKSPACE_NOT_FOUND'],
    ['ENOTDIR', 'WORKSPACE_NOT_DIRECTORY'],
    ['EACCES', 'WORKSPACE_ACCESS_DENIED'],
    ['EINVAL', 'WORKSPACE_PATH_INVALID'],
  ] as const)('maps filesystem %s to stable code %s', async (fsCode, expectedCode) => {
    const resolver = createFilesystemWorkspaceResolver({
      realpath: vi.fn(async () => {
        const error = new Error('filesystem detail') as Error & { code?: string };
        error.code = fsCode;
        throw error;
      }),
      stat: vi.fn(async () => ({ isDirectory: () => true })),
    });

    await expect(resolver.resolveWorkspace('/requested/path'))
      .rejects.toMatchObject({
        name: 'WorkspaceResolverError',
        code: expectedCode,
      });
  });

  it('rejects invalid paths before touching the filesystem', async () => {
    const realpath = vi.fn(async (path: string) => path);
    const stat = vi.fn(async () => ({ isDirectory: () => true }));
    const resolver = createFilesystemWorkspaceResolver({ realpath, stat });

    await expect(resolver.resolveWorkspace('relative/path'))
      .rejects.toBeInstanceOf(WorkspaceResolverError);
    expect(realpath).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });
});
