import { describe, expect, it } from "vitest";
import {
  applyDraftModelValue,
  chooseModelKind,
  customModelFromObservedModel,
  modelDisplayState,
  modelKindForModel,
  modelValueFromObservedModel,
  modelOptionForKind,
  resumableSessionForModelChange,
  selectedModelValue,
  versionNameForModel,
} from "./chatModelControls";
import type { ModelOption } from "./daemonClient";

const options: ModelOption[] = [
  { id: "claude-sonnet-4-6", label: "Sonnet" },
  { id: "claude-opus-4-7", label: "Opus" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku" },
];

describe("chatModelControls", () => {
  it("maps model IDs to model kinds", () => {
    expect(modelKindForModel("claude-opus-4-7", options, false)).toBe("opus");
    expect(modelKindForModel("claude-sonnet-4-6", options, false)).toBe("sonnet");
    expect(modelKindForModel("claude-haiku-4-5-20251001", options, false)).toBe("haiku");
    expect(modelKindForModel("gpt-5.5", options, false)).toBe("custom");
    expect(modelKindForModel("claude-opus-4-7", options, true)).toBe("custom");
  });

  it("displays built-in Claude models as kind plus version plus effort", () => {
    expect(modelDisplayState("claude-opus-4-7", options, "high", false)).toMatchObject({
      kind: "opus",
      kindLabel: "Opus",
      name: "4.7",
      summary: "Opus 4.7 high",
      editable: false,
    });
    expect(modelDisplayState("claude-sonnet-4-6", options, "xhigh", false).summary).toBe("Sonnet 4.6 xhigh");
    expect(modelDisplayState("claude-haiku-4-5-20251001", options, "low", false).summary).toBe("Haiku 4.5 low");
  });

  it("displays built-in kinds mapped to configured custom model IDs as the full configured name", () => {
    const configured: ModelOption[] = [
      { id: "gpt-5.4(xhigh)", label: "Opus" },
      { id: "gpt-5.5(medium)", label: "Sonnet" },
      { id: "grok-composer-2.5-fast", label: "Haiku" },
    ];

    expect(modelDisplayState("gpt-5.4(xhigh)", configured, "high", false)).toMatchObject({
      kind: "opus",
      kindLabel: "Opus",
      name: "gpt-5.4(xhigh)",
      summary: "Opus gpt-5.4(xhigh) high",
      editable: false,
    });
    expect(modelDisplayState("gpt-5.5(medium)", configured, "high", false).summary).toBe("Sonnet gpt-5.5(medium) high");
    expect(modelDisplayState("grok-composer-2.5-fast", configured, "low", false).summary).toBe("Haiku grok-composer-2.5-fast low");
  });

  it("displays custom models as Custom plus custom name plus effort", () => {
    expect(modelDisplayState("gpt-5.5", options, "high", false)).toMatchObject({
      kind: "custom",
      kindLabel: "Custom",
      name: "gpt-5.5",
      summary: "Custom gpt-5.5 high",
      editable: true,
    });
  });

  it("extracts compact version names from built-in model IDs", () => {
    expect(versionNameForModel("claude-opus-4-7", "opus")).toBe("4.7");
    expect(versionNameForModel("claude-opus-4-8", "opus")).toBe("4.8");
    expect(versionNameForModel("claude-haiku-4-5-20251001", "haiku")).toBe("4.5");
    expect(versionNameForModel("gpt-5.5(medium)", "sonnet")).toBe("gpt-5.5(medium)");
    expect(versionNameForModel("grok-composer-2.5-fast", "haiku")).toBe("grok-composer-2.5-fast");
    expect(versionNameForModel("gpt-5.5", "custom")).toBe("gpt-5.5");
  });

  it("resolves switchable preset model kinds from available options", () => {
    expect(modelOptionForKind("opus", options)?.id).toBe("claude-opus-4-7");
    expect(chooseModelKind("opus", "claude-sonnet-4-6", options, "gpt-5.5")).toEqual({
      model: "claude-opus-4-7",
      draftModel: "claude-opus-4-7",
      customModelEditing: false,
    });
  });

  it("rejects switching to a preset kind that is not available", () => {
    expect(chooseModelKind("haiku", "claude-sonnet-4-6", options.filter((o) => o.label !== "Haiku"), "gpt-5.5")).toEqual({
      error: "Haiku model is not available",
    });
  });

  it("switches to the saved custom model without requiring entry", () => {
    expect(chooseModelKind("custom", "claude-sonnet-4-6", options, "gpt-5.5")).toEqual({
      model: "gpt-5.5",
      draftModel: "gpt-5.5",
      customModelEditing: false,
    });
    expect(selectedModelValue("gpt-5.5", options, false)).toBe("custom");
  });

  it("enters custom mode with an empty draft when no custom model is saved", () => {
    expect(chooseModelKind("custom", "claude-sonnet-4-6", options, "")).toEqual({
      model: "claude-sonnet-4-6",
      draftModel: "",
      customModelEditing: true,
    });
    expect(selectedModelValue("claude-sonnet-4-6", options, true)).toBe("custom");
  });

  it("normalizes observed preset aliases before updating the displayed model", () => {
    expect(modelValueFromObservedModel("sonnet", options, "gpt-5.5")).toBe("claude-sonnet-4-6");
    expect(modelValueFromObservedModel("opus", options, "gpt-5.5")).toBe("claude-opus-4-7");
    expect(modelValueFromObservedModel("gpt-5.5", options, "claude-sonnet-4-6")).toBe("gpt-5.5");
  });

  it("normalizes preset aliases to configured model IDs", () => {
    const configured: ModelOption[] = [
      { id: "gpt-5.5", label: "Sonnet" },
      { id: "claude-opus-4-7", label: "Opus" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku" },
    ];

    expect(modelValueFromObservedModel("sonnet", configured, "claude-opus-4-7")).toBe("gpt-5.5");
    expect(modelDisplayState("gpt-5.5", configured, "high", false).summary).toBe("Sonnet gpt-5.5 high");
  });

  it("preserves saved custom models when preset aliases are observed", () => {
    expect(customModelFromObservedModel("sonnet", options, "gpt-5.5")).toBe("gpt-5.5");
    expect(customModelFromObservedModel("claude-sonnet-4-6", options, "gpt-5.5")).toBe("gpt-5.5");
    expect(customModelFromObservedModel("sonnet", options, "")).toBe("");
    expect(customModelFromObservedModel("gpt-5.5", options, "")).toBe("gpt-5.5");
  });

  it("applies and cancels custom model names", () => {
    expect(applyDraftModelValue("claude-sonnet-4-6", "  gpt-5.5  ")).toEqual({
      model: "gpt-5.5",
      draftModel: "gpt-5.5",
      customModelEditing: false,
    });
    expect(applyDraftModelValue("claude-sonnet-4-6", "   ")).toEqual({
      model: "claude-sonnet-4-6",
      draftModel: "claude-sonnet-4-6",
      customModelEditing: false,
    });
  });

  it("only resumes disk-backed history sessions for model changes", () => {
    expect(resumableSessionForModelChange("history-session-id")).toBe("history-session-id");
    expect(resumableSessionForModelChange(null)).toBeNull();
  });
});
