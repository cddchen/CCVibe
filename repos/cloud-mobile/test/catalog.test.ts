import { describe, expect, it } from 'vitest';

import {
  applyCatalogSync,
  catalogReducer,
  createRootCatalogState,
  type CatalogActionEnvelope,
} from '../src/domain/catalog';
import { createRootUri } from '../src/protocol/resourceUri';

const root = createRootUri();

describe('catalog state contract', () => {
  it('converges to the same canonical state from replay or snapshot', () => {
    const initial = createRootCatalogState();
    const actions: readonly CatalogActionEnvelope[] = [
      {
        channel: root,
        serverSeq: 1,
        serverTime: '2026-08-29T00:00:01.000Z',
        action: {
          type: 'catalog/workspaceUpserted',
          workspace: { id: 'workspace-1', name: 'CCVibe', path: '/workspace' },
        },
      },
      {
        channel: root,
        serverSeq: 3,
        serverTime: '2026-08-29T00:00:03.000Z',
        action: {
          type: 'catalog/sessionUpserted',
          session: {
            id: 'session-1',
            workspaceId: 'workspace-1',
            workspaceName: 'CCVibe',
            title: 'Foundation',
            updatedAt: '2026-08-29T00:00:03.000Z',
            status: 'idle',
          },
        },
      },
    ];
    const replayed = applyCatalogSync(initial, {
      type: 'replay',
      actions,
      throughSeq: 3,
    });
    const snapshotted = applyCatalogSync(initial, {
      type: 'snapshot',
      snapshot: {
        resource: root,
        fromSeq: 3,
        state: {
          resource: root,
          workspaces: replayed.workspaces,
          sessions: replayed.sessions,
          models: replayed.models,
          lastServerSeq: replayed.lastServerSeq,
          ...(replayed.defaultModelId === undefined ? {} : { defaultModelId: replayed.defaultModelId }),
        },
      },
      throughSeq: 3,
    });

    expect(snapshotted).toEqual(replayed);
    expect(catalogReducer(replayed, actions[1])).toBe(replayed);
  });

  it('rejects a reconnect cut that moves the catalog sequence backwards', () => {
    const state = createRootCatalogState();

    expect(() => applyCatalogSync(state, {
      type: 'replay',
      actions: [],
      throughSeq: -1,
    })).toThrow(RangeError);

    const advanced = applyCatalogSync(state, {
      type: 'replay',
      actions: [{
        channel: root,
        serverSeq: 2,
        serverTime: '2026-08-29T00:00:02.000Z',
        action: {
          type: 'catalog/modelsReplaced',
          models: [],
        },
      }],
      throughSeq: 2,
    });

    expect(() => applyCatalogSync(advanced, {
      type: 'replay',
      actions: [],
      throughSeq: 1,
    })).toThrow('catalog sync cut cannot move serverSeq backwards');
  });
});
