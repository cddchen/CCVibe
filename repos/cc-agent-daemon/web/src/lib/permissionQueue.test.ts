import { describe, expect, it } from "vitest";
import { resolvePermission, upsertPermission } from "./permissionQueue";

describe("permissionQueue", () => {
  const first = { conversationId: "c1", requestId: "r1", toolName: "Read", input: { path: "a" } };
  const second = { conversationId: "c1", requestId: "r2", toolName: "Bash", input: { command: "pwd" } };

  it("queues parallel requests and updates redelivered request snapshots", () => {
    const queue = upsertPermission(upsertPermission([], first), second);
    expect(queue.map((item) => item.requestId)).toEqual(["r1", "r2"]);
    expect(upsertPermission(queue, { ...first, input: { path: "b" } })[0].input).toEqual({ path: "b" });
  });

  it("removes only the resolved request", () => {
    const queue = [first, second];
    expect(resolvePermission(queue, "c1", "r1")).toEqual([second]);
  });
});
