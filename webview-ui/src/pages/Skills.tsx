import { useEffect, useState } from "react";
import { postOpenExternal, requestSkills, type SkillState } from "../vscodeApi";

const sources = [
  { id: "ui-ux-pro-max", title: "UI UX Pro Max", author: "nextlevelbuilder", description: "Design intelligence for UI/UX across platforms. Includes data and Python search scripts (Python 3 required for searches).", url: "https://github.com/nextlevelbuilder/ui-ux-pro-max-skill" },
  { id: "wondel", title: "Wondel.ai Skills", author: "wondelai", description: "Business, marketing, UX, and coding frameworks. Select one skill to install at a time.", url: "https://github.com/wondelai/skills" },
  { id: "humanizer", title: "Humanizer", author: "blader", description: "Rewrite AI-sounding text into more natural prose while preserving its meaning.", url: "https://github.com/blader/humanizer" },
] as const;

export function Skills() {
  const [names, setNames] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [statuses, setStatuses] = useState<Record<string, SkillState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void requestSkills("list").then((response) => {
      if (!active) return;
      if (response.names) { setNames(response.names); setSelected(response.names[0] ?? ""); }
      if (response.error) setError(response.error);
    });
    return () => { active = false; };
  }, []);

  const selectedId = selected ? `wondel/${selected}` : "";
  useEffect(() => {
    let active = true;
    for (const id of ["ui-ux-pro-max", "humanizer", selectedId].filter(Boolean)) {
      void requestSkills("status", id).then((response) => {
        if (!active) return;
        if (response.status) setStatuses((current) => ({ ...current, [id]: response.status! }));
        if (response.error) setError(response.error);
      });
    }
    return () => { active = false; };
  }, [selectedId]);

  async function act(id: string, action: "install" | "remove") {
    setBusy(id);
    setError(null);
    try {
      const response = await requestSkills(action, id);
      if (response.status) setStatuses((current) => ({ ...current, [id]: response.status! }));
      if (response.error) setError(response.error);
    } finally { setBusy(null); }
  }

  return (
    <div className="page">
      <div>
        <h1>Skills</h1>
        <p className="page-hint">Install third-party agent skills for this workspace. Review source files before using them; installation downloads files but never runs their scripts.</p>
      </div>
      {error && <div className="rtk-banner error" role="alert">{error}</div>}
      <div className="grid">
        {sources.map((source) => {
          const id = source.id === "wondel" ? selectedId : source.id;
          const status = statuses[id];
          return (
            <div className="card" key={source.id}>
              <div className="card-title">{source.title}</div>
              <div className="card-desc">by {source.author}</div>
              <p>{source.description}</p>
              {source.id === "wondel" && (
                <label className="skills-picker">Choose skill
                  <select value={selected} disabled={busy !== null || names.length === 0} onChange={(event) => setSelected(event.target.value)}>
                    {names.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                  {names.length === 0 && <span className="card-desc">Loading available skills…</span>}
                </label>
              )}
              <div className="card-desc" role="status">{!id ? "Choose a skill" : status === "installed" ? "Installed" : status === "not-installed" ? "Not installed" : status === "conflict" ? "Existing/modified files — manage manually" : "Checking status…"}</div>
              <div className="btn-row">
                <button className="btn" disabled={busy !== null || !id || status !== "not-installed"} onClick={() => void act(id, "install")}>Install</button>
                <button className="btn secondary" disabled={busy !== null || !id || status !== "installed"} onClick={() => void act(id, "remove")}>Remove</button>
                <button className="btn secondary" onClick={() => postOpenExternal(source.url)}>Source ↗</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}