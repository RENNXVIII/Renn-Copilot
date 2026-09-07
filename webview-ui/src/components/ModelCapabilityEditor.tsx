import { useEffect, useState } from "react";
import type { ModelCapabilityPatch, ModelEntry, ModelTokenLimits } from "../api/client";
import {
  capabilityFormFromModel,
  capabilityPatchFromForm,
  COMMON_REASONING_LEVELS,
  type CapabilityFormState,
} from "../lib/capability-form";
import { Modal, ModalHeader } from "./Modal";

interface Props {
  model: ModelEntry | null;
  saving: boolean;
  verifying: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (patch: ModelCapabilityPatch) => Promise<void>;
  onVerifyVision: () => Promise<void>;
}

const TOKEN_FIELDS: Array<{ key: keyof ModelTokenLimits; label: string; description: string }> = [
  { key: "contextTokens", label: "Context size", description: "Total context window tracked by Renn." },
  { key: "inputTokens", label: "Max input tokens", description: "Maximum prompt/input allocation." },
  { key: "outputTokens", label: "Max output tokens", description: "Maximum generated output allocation." },
];

function formatTokens(value?: number) {
  return value ? value.toLocaleString() : "Unknown";
}

export function ModelCapabilityEditor({ model, saving, verifying, error, onClose, onSave, onVerifyVision }: Props) {
  const [form, setForm] = useState<CapabilityFormState | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    setForm(model ? capabilityFormFromModel(model) : null);
    setValidationError(null);
  }, [model?.id]);

  if (!model || !form) return <Modal open={false} onClose={onClose}>{null}</Modal>;
  const currentModel = model;
  const currentForm = form;

  function update<K extends keyof CapabilityFormState>(field: K, value: CapabilityFormState[K]) {
    setForm((current) => current && { ...current, [field]: value });
    setValidationError(null);
  }

  async function submit() {
    try {
      await onSave(capabilityPatchFromForm(currentForm));
    } catch (err) {
      setValidationError((err as Error).message);
    }
  }

  function resetAll() {
    setForm({
      ...capabilityFormFromModel(currentModel),
      vision: "auto",
      reasoningMode: "auto",
      reasoningLevels: [],
      customReasoningLevels: "",
      tokenModes: { contextTokens: "auto", inputTokens: "auto", outputTokens: "auto" },
    });
    setValidationError(null);
  }

  const detected = model.capabilityConfiguration.limits.detected;
  const close = saving || verifying ? () => undefined : onClose;

  return (
    <Modal open onClose={close}>
      <div className="capability-modal">
        <ModalHeader title="Override capabilities" description={`${model.label} · ${model.id}`} onClose={close} />

        <section className="capability-section">
          <div className="capability-section-heading">
            <div>
              <div className="capability-section-title">Vision</div>
              <div className="card-desc">Auto keeps catalog or verified probe evidence.</div>
            </div>
            <button className="btn secondary" disabled={saving || verifying} onClick={onVerifyVision}>
              {verifying ? "Checking..." : "Re-check vision"}
            </button>
          </div>
          <select className="text-input" aria-label="Vision override" value={form.vision} onChange={(event) => update("vision", event.target.value as CapabilityFormState["vision"])}>
            <option value="auto">Auto ({String(model.capabilities.vision)})</option>
            <option value="supported">Supported</option>
            <option value="unsupported">Unsupported</option>
          </select>
        </section>

        <section className="capability-section">
          <div className="capability-section-title">Reasoning / thinking</div>
          <div className="card-desc">Override whether reasoning is supported and which effort levels VS Code may offer.</div>
          <select className="text-input" aria-label="Reasoning override" value={form.reasoningMode} onChange={(event) => update("reasoningMode", event.target.value as CapabilityFormState["reasoningMode"])}>
            <option value="auto">Auto ({model.capabilityConfiguration.reasoning.supported ? "supported" : "not detected"})</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
          {form.reasoningMode === "enabled" && (
            <>
              <div className="capability-levels" aria-label="Supported reasoning effort levels">
                {COMMON_REASONING_LEVELS.map((level) => (
                  <label key={level} className="capability-level-option">
                    <input
                      type="checkbox"
                      checked={form.reasoningLevels.includes(level)}
                      onChange={(event) =>
                        update(
                          "reasoningLevels",
                          event.target.checked
                            ? [...form.reasoningLevels, level]
                            : form.reasoningLevels.filter((item) => item !== level)
                        )
                      }
                    />
                    {level}
                  </label>
                ))}
              </div>
              <label className="field">
                <span className="field-label">Custom levels (comma-separated)</span>
                <input className="text-input" value={form.customReasoningLevels} onChange={(event) => update("customReasoningLevels", event.target.value)} placeholder="ultra, extreme" />
              </label>
            </>
          )}
        </section>

        <section className="capability-section">
          <div className="capability-section-title">Token limits</div>
          <div className="card-desc">Stored as internal metadata only. These values are not exported to VS Code.</div>
          <div className="capability-token-grid">
            {TOKEN_FIELDS.map(({ key, label, description }) => (
              <div className="capability-token-field" key={key}>
                <div>
                  <label className="field-label" htmlFor={`capability-${key}`}>{label}</label>
                  <div className="card-desc">{description} Detected: {formatTokens(detected[key])}</div>
                </div>
                <select
                  className="capability-select"
                  aria-label={`${label} mode`}
                  value={form.tokenModes[key]}
                  onChange={(event) => update("tokenModes", { ...form.tokenModes, [key]: event.target.value as "auto" | "manual" })}
                >
                  <option value="auto">Auto</option>
                  <option value="manual">Manual</option>
                </select>
                <input
                  id={`capability-${key}`}
                  className="text-input"
                  inputMode="numeric"
                  disabled={form.tokenModes[key] === "auto"}
                  value={form.tokenValues[key]}
                  onChange={(event) => update("tokenValues", { ...form.tokenValues, [key]: event.target.value })}
                  placeholder={formatTokens(detected[key])}
                />
              </div>
            ))}
          </div>
        </section>

        {(validationError || error) && <div className="capability-error" role="alert">{validationError || error}</div>}

        <div className="capability-modal-actions">
          <button className="btn secondary" disabled={saving || verifying} onClick={resetAll}>Reset all to Auto</button>
          <div className="btn-row">
            <button className="btn secondary" disabled={saving || verifying} onClick={onClose}>Cancel</button>
            <button className="btn" disabled={saving || verifying} onClick={submit}>{saving ? "Saving..." : "Save overrides"}</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
