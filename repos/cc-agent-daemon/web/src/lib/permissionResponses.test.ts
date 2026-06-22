import { describe, expect, it } from "vitest";
import {
  buildPermissionRespondParams,
  parseUpdatedInput,
  permissionInputText,
  type PermissionRequest,
} from "./permissionResponses";

const request: PermissionRequest = {
  sessionId: "sess-1",
  requestId: "req-1",
  toolName: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "继续执行吗？",
        header: "确认",
        options: [{ label: "确认", description: "继续" }],
        multiSelect: false,
      },
    ],
  },
};

describe("permissionResponses", () => {
  it("formats permission input so the UI can submit an editable updatedInput", () => {
    expect(permissionInputText(request.input)).toContain("继续执行吗？");
    expect(permissionInputText(undefined)).toBe("{}");
  });

  it("builds allow responses with user-edited updatedInput for input tools", () => {
    expect(
      buildPermissionRespondParams(request, "allow", {
        updatedInputText: JSON.stringify({ answers: { "继续执行吗？": "确认" } }),
      }),
    ).toEqual({
      sessionId: "sess-1",
      requestId: "req-1",
      behavior: "allow",
      updatedInput: { answers: { "继续执行吗？": "确认" } },
    });
  });

  it("builds allow responses without updatedInput when the user leaves it blank", () => {
    expect(buildPermissionRespondParams(request, "allow", { updatedInputText: "   " })).toEqual({
      sessionId: "sess-1",
      requestId: "req-1",
      behavior: "allow",
    });
  });

  it("builds deny responses with a user message", () => {
    expect(buildPermissionRespondParams(request, "deny", { denyMessage: "不要进入计划" })).toEqual({
      sessionId: "sess-1",
      requestId: "req-1",
      behavior: "deny",
      message: "不要进入计划",
    });
  });

  it("rejects non-object updatedInput JSON", () => {
    expect(() => parseUpdatedInput("[]")).toThrow(/JSON object/);
    expect(() => parseUpdatedInput('"yes"')).toThrow(/JSON object/);
  });
});
