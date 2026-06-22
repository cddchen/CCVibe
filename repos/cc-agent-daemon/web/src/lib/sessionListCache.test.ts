import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCachedSessionList,
  getCachedSessionList,
  loadSessionList,
  sessionGroups,
} from "./sessionListCache";

function clientWithFixtures() {
  const call = vi.fn(async (method: string, params?: unknown) => {
    if (method === "history.listAllLocal") {
      return {
        projects: [
          {
            workspacePath: "/repo/a",
            sessions: [
              { sessionId: "a-old", messageCount: 1, lastTimestamp: "2026-01-01T00:00:00.000Z" },
              { sessionId: "a-new", messageCount: 2, lastTimestamp: "2026-01-03T00:00:00.000Z" },
            ],
          },
        ],
      };
    }
    if (method === "workspace.list") {
      return {
        workspaces: [
          { id: "manual-b", path: "/repo/b", createdAt: "2026-01-02T00:00:00.000Z" },
        ],
      };
    }
    if (method === "history.listSessions") {
      expect(params).toEqual({ workspacePath: "/repo/b" });
      return {
        sessions: [
          { sessionId: "b-session", messageCount: 3, lastTimestamp: "2026-01-04T00:00:00.000Z" },
        ],
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { call: call as typeof call & (<T>(method: string, params?: unknown) => Promise<T>) };
}

describe("sessionListCache", () => {
  beforeEach(() => {
    clearCachedSessionList();
  });

  it("loads and caches all workspace sessions", async () => {
    const client = clientWithFixtures();

    const first = await loadSessionList(client);
    const second = await loadSessionList(client);

    expect(second).toBe(first);
    expect(getCachedSessionList()).toBe(first);
    expect(client.call).toHaveBeenCalledTimes(3);
  });

  it("force reloads instead of using cached data", async () => {
    const client = clientWithFixtures();

    await loadSessionList(client);
    await loadSessionList(client, { force: true });

    expect(client.call).toHaveBeenCalledTimes(6);
  });

  it("sorts groups and sessions by latest timestamp", async () => {
    const client = clientWithFixtures();
    const data = await loadSessionList(client);

    const groups = sessionGroups(data);

    expect(groups.map((g) => g.workspace.path)).toEqual(["/repo/b", "/repo/a"]);
    expect(groups[1].sessions.map((s) => s.sessionId)).toEqual(["a-new", "a-old"]);
  });
});
