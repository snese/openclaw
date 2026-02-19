import type { SessionEntry } from "../config/sessions.js";

type ModelRef = {
  provider: string;
  model: string;
  label: string;
};

function normalizeModelRef(
  rawModel: string,
  fallbackProvider: string,
  parseEmbeddedProvider = false,
): ModelRef {
  const trimmed = String(rawModel ?? "").trim();
  const slashIndex = parseEmbeddedProvider ? trimmed.indexOf("/") : -1;
  if (slashIndex > 0) {
    const provider = trimmed.slice(0, slashIndex).trim();
    const model = trimmed.slice(slashIndex + 1).trim();
    if (provider && model) {
      return {
        provider,
        model,
        label: `${provider}/${model}`,
      };
    }
  }
  const provider = String(fallbackProvider ?? "").trim();
  return {
    provider,
    model: trimmed,
    label: provider ? `${provider}/${trimmed}` : trimmed,
  };
}

export function resolveSelectedAndActiveModel(params: {
  selectedProvider: string;
  selectedModel: string;
  sessionEntry?: Pick<SessionEntry, "modelProvider" | "model">;
}): {
  selected: ModelRef;
  active: ModelRef;
  activeDiffers: boolean;
} {
  const selected = normalizeModelRef(params.selectedModel, params.selectedProvider);
  const runtimeModel = params.sessionEntry?.model?.trim();
  const runtimeProvider = params.sessionEntry?.modelProvider?.trim();

  const active = runtimeModel
    ? normalizeModelRef(runtimeModel, runtimeProvider || selected.provider, !runtimeProvider)
    : selected;
  const activeDiffers = active.provider !== selected.provider || active.model !== selected.model;

  return {
    selected,
    active,
    activeDiffers,
  };
}
