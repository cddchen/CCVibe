import type { ModelOption } from "./daemonClient";

export type ModelKind = "opus" | "sonnet" | "haiku" | "custom";

export type ModelSelectionState = {
  model: string;
  draftModel: string;
  customModelEditing: boolean;
};

export type ModelDisplayState = {
  kind: ModelKind;
  kindLabel: "Opus" | "Sonnet" | "Haiku" | "Custom";
  name: string;
  summary: string;
  editable: boolean;
};

export const MODEL_KIND_OPTIONS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
  { id: "custom", label: "Custom" },
] as const satisfies readonly { id: ModelKind; label: string }[];

const KIND_LABELS: Record<ModelKind, ModelDisplayState["kindLabel"]> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  custom: "Custom",
};

export function modelKindForOption(option: ModelOption): Exclude<ModelKind, "custom"> | null {
  const value = `${option.id} ${option.label}`.toLowerCase();
  if (value.includes("opus")) return "opus";
  if (value.includes("sonnet")) return "sonnet";
  if (value.includes("haiku")) return "haiku";
  return null;
}

export function modelOptionForKind(
  kind: Exclude<ModelKind, "custom">,
  modelOptions: readonly ModelOption[],
): ModelOption | null {
  return modelOptions.find((option) => modelKindForOption(option) === kind) ?? null;
}

export function modelKindForModel(
  model: string,
  modelOptions: readonly ModelOption[],
  customModelEditing: boolean,
): ModelKind {
  if (customModelEditing) return "custom";
  const matched = modelOptions.find((option) => option.id === model);
  return matched ? modelKindForOption(matched) ?? "custom" : "custom";
}

export function modelValueFromObservedModel(
  observedModel: string,
  modelOptions: readonly ModelOption[],
  currentModel: string,
): string {
  const observed = observedModel.trim();
  const lower = observed.toLowerCase();
  if (lower === "opus" || lower === "sonnet" || lower === "haiku") {
    return modelOptionForKind(lower, modelOptions)?.id ?? currentModel;
  }
  return observed || currentModel;
}

export function customModelFromObservedModel(
  observedModel: string,
  modelOptions: readonly ModelOption[],
  currentCustomModel: string,
): string {
  const current = currentCustomModel.trim();
  if (current) return current;
  const observed = observedModel.trim();
  if (!observed) return currentCustomModel;
  const lower = observed.toLowerCase();
  if (lower === "opus" || lower === "sonnet" || lower === "haiku") return currentCustomModel;
  if (modelOptions.some((option) => option.id === observed)) return currentCustomModel;
  return observed;
}

export function versionNameForModel(model: string, kind: ModelKind): string {
  if (kind === "custom") return model;
  const match = model.match(/claude-(?:opus|sonnet|haiku)-(\d+)-(\d+)/i);
  return match ? `${match[1]}.${match[2]}` : model;
}

export function modelDisplayState(
  model: string,
  modelOptions: readonly ModelOption[],
  effort: string,
  customModelEditing: boolean,
): ModelDisplayState {
  const kind = modelKindForModel(model, modelOptions, customModelEditing);
  const name = customModelEditing ? "" : versionNameForModel(model, kind);
  const kindLabel = KIND_LABELS[kind];
  return {
    kind,
    kindLabel,
    name,
    summary: [kindLabel, name, effort].filter(Boolean).join(" "),
    editable: kind === "custom",
  };
}

export function chooseModelKind(
  kind: ModelKind,
  currentModel: string,
  modelOptions: readonly ModelOption[],
  customModel: string,
): ModelSelectionState | { error: string } {
  if (kind === "custom") {
    const saved = customModel.trim();
    return saved ? choosePresetModel(saved) : beginCustomModelEntry(currentModel);
  }
  const option = modelOptionForKind(kind, modelOptions);
  if (!option) return { error: `${KIND_LABELS[kind]} model is not available` };
  return choosePresetModel(option.id);
}

export function selectedModelValue(
  model: string,
  modelOptions: readonly ModelOption[],
  customModelEditing: boolean,
): ModelKind {
  return modelKindForModel(model, modelOptions, customModelEditing);
}

export function beginCustomModelEntry(currentModel: string): ModelSelectionState {
  return {
    model: currentModel,
    draftModel: "",
    customModelEditing: true,
  };
}

export function choosePresetModel(next: string): ModelSelectionState {
  return {
    model: next,
    draftModel: next,
    customModelEditing: false,
  };
}

export function applyDraftModelValue(currentModel: string, draftModel: string): ModelSelectionState {
  const next = draftModel.trim();
  if (!next) {
    return {
      model: currentModel,
      draftModel: currentModel,
      customModelEditing: false,
    };
  }
  return {
    model: next,
    draftModel: next,
    customModelEditing: false,
  };
}

export function resumableSessionForModelChange(historySessionId: string | null): string | null {
  return historySessionId;
}
