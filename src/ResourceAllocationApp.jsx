import React, { useState, useMemo, useEffect, useCallback } from "react";
import { supabase } from "./supabase";

const URGENCY = {
  "Specification - Fast": 50,
  "Specification - Normal": 35,
  "Construction - Urgent": 25,
  "Construction - Can Wait": 10,
};
const COMPLEXITY = { Low: 5, Medium: 15, High: 30 };
const SIZE = { Small: 5, Medium: 10, Large: 20, Mega: 30 };

const SEGMENT_FIT = {
  "Retail/Office/Industry": { Tatiana: 1.0, Inna: 0.8, Nour: 0.5, "Manager Reserve": 0.6 },
  Facade: { Inna: 1.0, Nour: 0.5, "Manager Reserve": 0.6 },
  Sports: { Vivek: 1.0, "Manager Reserve": 0.5 },
  Road: { Karim: 0.9, Inna: 0.8, Vivek: 0.4, "Manager Reserve": 0.5 },
  Tunnel: { Farhan: 1.0, Inna: 0.6, "Manager Reserve": 0.6 },
};

const SEGMENT_OUTSOURCE = {
  "Retail/Office/Industry": "Russian outsourcing — large repetitive packages",
  Facade: "Local; partner only for overflow drafting",
  Sports: "Local; partner only for overflow calculations",
  Road: "Turkish LIAS — repetitive full road packages",
  Tunnel: "Partner only after technical gate",
};

const INITIAL_TEAM = [
  { name: "Tatiana", role: "Senior lighting designer", base: 32, committed: 22, skill: 1.0, iconic: true },
  { name: "Inna", role: "Senior lighting designer", base: 30, committed: 20, skill: 1.0, iconic: true },
  { name: "Vivek", role: "Lighting designer", base: 28, committed: 16, skill: 0.85, iconic: false },
  { name: "Vikash", role: "Project manager (unavailable)", base: 0, committed: 0, skill: 0, iconic: false },
  { name: "Farhan", role: "Specifier relations + tunnel", base: 10, committed: 6, skill: 0.8, iconic: false },
  { name: "Nour", role: "Intern / creative support", base: 20, committed: 10, skill: 0.45, iconic: false },
  { name: "Karim", role: "Specifier relations + road", base: 12, committed: 7, skill: 0.55, iconic: false },
  { name: "Manager Reserve", role: "Strategic reserve / QA", base: 8, committed: 4, skill: 1.0, iconic: true },
];

const FIELD = {
  segment: Object.keys(SEGMENT_FIT),
  size: Object.keys(SIZE),
  complexity: Object.keys(COMPLEXITY),
  urgency: Object.keys(URGENCY),
  phase: ["Specification", "Construction"],
};

function scoreProject(p) {
  const raw = (URGENCY[p.urgency] || 0) + (COMPLEXITY[p.complexity] || 0) + (SIZE[p.size] || 0) + (p.iconic ? 25 : 0);
  let tier, tierLabel, color;
  if (raw >= 80) { tier = 1; tierLabel = "Tier 1 - Critical"; color = "#A32D2D"; }
  else if (raw >= 50) { tier = 2; tierLabel = "Tier 2 - Important"; color = "#854F0B"; }
  else { tier = 3; tierLabel = "Tier 3 - Backlog"; color = "#3B6D11"; }
  return { raw, tier, tierLabel, color };
}

function recommendPeople(p, team, committedExtra) {
  const fitMap = SEGMENT_FIT[p.segment] || {};
  const highComplexity = p.complexity === "High";
  const results = [];

  for (const t of team) {
    if (t.base === 0) continue;
    const fit = fitMap[t.name];
    if (fit === undefined) continue;

    const liveCommitted = t.committed + (committedExtra[t.name] || 0);
    const available = t.base - liveCommitted;
    const headroom = Math.max(0, Math.min(1, available / Math.max(p.hrs, 1)));

    const reasons = [];
    const capacityScore = headroom;
    if (available <= 0) reasons.push("No spare capacity");
    else if (available < p.hrs) reasons.push(`Only ${available}h free vs ${p.hrs}h needed`);
    else reasons.push(`${available}h free — fits the ${p.hrs}h job`);

    const fitScore = fit;
    reasons.push(fit >= 0.9 ? "Primary segment owner" : fit >= 0.6 ? "Credible backup for this segment" : "Support-level segment fit");

    let skillScore = t.skill;
    if (highComplexity && t.skill < 0.8) { skillScore *= 0.5; reasons.push("High-complexity job — below senior skill"); }
    else if (highComplexity) reasons.push("Senior skill suits high complexity");

    let iconicScore = 1;
    if (p.iconic && !t.iconic) { iconicScore = 0.4; reasons.push("Iconic project — not iconic-certified"); }
    else if (p.iconic) reasons.push("Iconic-certified");

    const total = Math.round(
      (capacityScore * 0.35 + fitScore * 0.30 + skillScore * 0.20 + iconicScore * 0.15) * 100
    );

    results.push({ name: t.name, role: t.role, total, available, reasons });
  }

  results.sort((a, b) => b.total - a.total);
  return results;
}

function bestRoute(p, team, committedExtra) {
  const sc = scoreProject(p);
  const ranked = recommendPeople(p, team, committedExtra);
  const top = ranked[0];
  let pathNote;
  if (!top) pathNote = "No eligible internal owner — escalate to manager.";
  else if (top.total < 45 || (top.available <= 0 && sc.tier !== 1))
    pathNote = `Internal capacity tight — consider: ${SEGMENT_OUTSOURCE[p.segment] || "external support"}.`;
  else if (sc.tier === 1) pathNote = "Tier 1 — keep local, senior QA mandatory.";
  else if (sc.tier === 2 && p.repetitive) pathNote = `Local setup, then: ${SEGMENT_OUTSOURCE[p.segment]}.`;
  else pathNote = "Local production; partner only on overflow.";
  return { sc, ranked, top, pathNote };
}

export default function ResourceAllocationApp() {
  const [team] = useState(INITIAL_TEAM);
  const [projects, setProjects] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState("dashboard");
  const [expanded, setExpanded] = useState(null);
  const [form, setForm] = useState({
    name: "", phase: "Specification", segment: "Road", size: "Medium",
    complexity: "Medium", iconic: false, urgency: "Specification - Normal",
    repetitive: false, hrs: 20,
  });

  const fetchData = useCallback(async () => {
    const [{ data: proj }, { data: asgn }] = await Promise.all([
      supabase.from("projects").select("*").order("created_at", { ascending: true }),
      supabase.from("assignments").select("*"),
    ]);
    if (proj) setProjects(proj);
    if (asgn) {
      const map = {};
      for (const a of asgn) map[a.project_id] = a.assignee;
      setAssignments(map);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();

    const projSub = supabase
      .channel("projects-channel")
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, fetchData)
      .subscribe();

    const asgnSub = supabase
      .channel("assignments-channel")
      .on("postgres_changes", { event: "*", schema: "public", table: "assignments" }, fetchData)
      .subscribe();

    return () => {
      supabase.removeChannel(projSub);
      supabase.removeChannel(asgnSub);
    };
  }, [fetchData]);

  const committedExtra = useMemo(() => {
    const m = {};
    for (const p of projects) {
      const who = assignments[p.id];
      if (who) m[who] = (m[who] || 0) + Number(p.hrs || 0);
    }
    return m;
  }, [projects, assignments]);

  const scored = useMemo(
    () => projects.map((p) => {
      const s = scoreProject(p);
      return { ...p, ...s, route: bestRoute(p, team, committedExtra) };
    }),
    [projects, team, committedExtra]
  );

  const stats = useMemo(() => ({
    open: scored.length,
    tier1: scored.filter((p) => p.tier === 1).length,
    totalHrs: scored.reduce((a, p) => a + Number(p.hrs || 0), 0),
    assigned: Object.keys(assignments).length,
  }), [scored, assignments]);

  async function addProject() {
    if (!form.name.trim()) return;
    setSaving(true);
    const nextId = "P-" + String(projects.length + 1).padStart(3, "0");
    await supabase.from("projects").insert({
      id: nextId,
      name: form.name,
      phase: form.phase,
      segment: form.segment,
      size: form.size,
      complexity: form.complexity,
      iconic: form.iconic,
      urgency: form.urgency,
      repetitive: form.repetitive,
      hrs: Number(form.hrs),
    });
    setForm({ ...form, name: "" });
    setSaving(false);
    setView("dashboard");
  }

  async function assignPerson(projectId, personName) {
    setAssignments((prev) => ({ ...prev, [projectId]: personName }));
    await supabase.from("assignments").upsert({ project_id: projectId, assignee: personName });
  }

  const C = { navy: "#1F3864", accent: "#2E75B6", ink: "#1a1a1a", muted: "#5f5f5f", line: "#e3e3e3", bg: "#f7f8fa", card: "#fff" };
  const wrap = { fontFamily: "Segoe UI, Helvetica, Arial, sans-serif", color: C.ink, background: C.bg, minHeight: "100vh", padding: "0 0 40px" };
  const tabStyle = (a) => ({ padding: "10px 18px", border: "none", cursor: "pointer", fontSize: 14, fontWeight: a ? 600 : 400, color: a ? "#fff" : C.navy, background: a ? C.navy : "transparent", borderRadius: 6 });
  const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 18 };
  const labelStyle = { fontSize: 12, fontWeight: 600, color: C.muted, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 };
  const inputStyle = { width: "100%", padding: "8px 10px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 14, boxSizing: "border-box" };
  const barColor = (v) => (v >= 70 ? "#3B6D11" : v >= 45 ? "#854F0B" : "#A32D2D");

  return (
    <div style={wrap}>
      <div style={{ background: C.navy, color: "#fff", padding: "20px 28px" }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Signify Lighting Design — Resource Allocation</div>
        <div style={{ fontSize: 13, opacity: 0.8, marginTop: 2 }}>
          Smart assignment — the engine ranks who fits each project; the manager decides.
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, padding: "14px 28px", background: "#fff", borderBottom: `1px solid ${C.line}` }}>
        <button style={tabStyle(view === "dashboard")} onClick={() => setView("dashboard")}>Dashboard</button>
        <button style={tabStyle(view === "intake")} onClick={() => setView("intake")}>New Project Intake</button>
        <button style={tabStyle(view === "team")} onClick={() => setView("team")}>Team Capacity</button>
      </div>

      <div style={{ padding: "22px 28px", maxWidth: 1000, margin: "0 auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: C.muted, fontSize: 15 }}>Loading projects…</div>
        ) : (
          <>
            {view === "dashboard" && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
                  {[["Open projects", stats.open], ["Tier 1 — Critical", stats.tier1], ["Assigned", stats.assigned + " / " + stats.open], ["Pipeline hours", stats.totalHrs + " h"]].map(([k, v]) => (
                    <div key={k} style={{ ...card, padding: 14 }}>
                      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>{k}</div>
                      <div style={{ fontSize: 26, fontWeight: 700, color: C.navy, marginTop: 4 }}>{v}</div>
                    </div>
                  ))}
                </div>

                <div style={card}>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: C.navy }}>Triaged Projects — with smart recommendations</div>
                  {scored.length === 0 ? (
                    <div style={{ color: C.muted, textAlign: "center", padding: 40 }}>No projects yet — add one via New Project Intake.</div>
                  ) : (
                    <div style={{ display: "grid", gap: 10 }}>
                      {scored.slice().sort((a, b) => b.raw - a.raw).map((p) => {
                        const open = expanded === p.id;
                        const chosen = assignments[p.id];
                        return (
                          <div key={p.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "12px 14px", borderLeft: `5px solid ${p.color}` }}>
                            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                              <div>
                                <b>{p.id}</b><span style={{ marginLeft: 8 }}>{p.name}</span>
                                {p.iconic && <span style={{ marginLeft: 8, fontSize: 11, background: "#FAEEDA", color: "#854F0B", padding: "2px 8px", borderRadius: 10, fontWeight: 600 }}>ICONIC</span>}
                              </div>
                              <div style={{ fontWeight: 700, color: p.color }}>{p.tierLabel} · score {p.raw}</div>
                            </div>
                            <div style={{ fontSize: 13, color: C.muted, marginTop: 6, display: "flex", flexWrap: "wrap", gap: 14 }}>
                              <span>{p.segment} · {p.phase}</span><span>{p.size} · {p.complexity}</span><span>{p.urgency}</span><span>~{p.hrs} h</span>
                            </div>

                            <div style={{ marginTop: 8, padding: "8px 10px", background: C.bg, borderRadius: 6, fontSize: 13 }}>
                              {p.route.top ? (
                                <>
                                  <b style={{ color: C.navy }}>Recommended:</b> {p.route.top.name}
                                  <span style={{ marginLeft: 6, fontSize: 12, background: "#E6F1FB", color: "#0C447C", padding: "1px 7px", borderRadius: 8, fontWeight: 600 }}>
                                    fit {p.route.top.total}/100
                                  </span>
                                  <div style={{ color: C.muted, marginTop: 3 }}>{p.route.pathNote}</div>
                                </>
                              ) : <span style={{ color: "#A32D2D" }}>{p.route.pathNote}</span>}
                              <button onClick={() => setExpanded(open ? null : p.id)} style={{ marginTop: 6, background: "none", border: `1px solid ${C.line}`, borderRadius: 5, padding: "3px 9px", fontSize: 12, cursor: "pointer", color: C.navy }}>
                                {open ? "Hide ranking" : "Why? See full ranking"}
                              </button>

                              {open && (
                                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                                  {p.route.ranked.map((r, i) => (
                                    <div key={r.name} style={{ background: "#fff", border: `1px solid ${C.line}`, borderRadius: 6, padding: "7px 9px" }}>
                                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                        <span><b>{i + 1}. {r.name}</b> <span style={{ color: C.muted, fontSize: 12 }}>· {r.role}</span></span>
                                        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                          <span style={{ width: 90, height: 7, background: "#eee", borderRadius: 4, overflow: "hidden", display: "inline-block" }}>
                                            <span style={{ display: "block", width: r.total + "%", height: "100%", background: barColor(r.total) }} />
                                          </span>
                                          <b style={{ color: barColor(r.total) }}>{r.total}</b>
                                        </span>
                                      </div>
                                      <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>{r.reasons.join(" · ")}</div>
                                      <button onClick={() => assignPerson(p.id, r.name)}
                                        style={{ marginTop: 5, background: chosen === r.name ? C.navy : "transparent", color: chosen === r.name ? "#fff" : C.navy, border: `1px solid ${C.navy}`, borderRadius: 5, padding: "3px 11px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                                        {chosen === r.name ? "Assigned ✓" : "Assign"}
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {chosen && !open && <div style={{ marginTop: 4, color: C.navy }}><b>Assigned to:</b> {chosen}</div>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}

            {view === "intake" && (
              <div style={{ ...card, maxWidth: 640 }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4, color: C.navy }}>New Project Intake</div>
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 16 }}>The engine scores, ranks the team, and recommends an owner.</div>
                <div style={{ marginBottom: 12 }}>
                  <label style={labelStyle}>Project name</label>
                  <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Marina Tower Facade" />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {["phase", "segment", "size", "complexity", "urgency"].map((f) => (
                    <div key={f}>
                      <label style={labelStyle}>{f}</label>
                      <select style={inputStyle} value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })}>
                        {FIELD[f].map((o) => <option key={o}>{o}</option>)}
                      </select>
                    </div>
                  ))}
                  <div>
                    <label style={labelStyle}>Est. design hours</label>
                    <input type="number" style={inputStyle} value={form.hrs} onChange={(e) => setForm({ ...form, hrs: e.target.value })} />
                  </div>
                </div>
                <div style={{ display: "flex", gap: 20, margin: "14px 0" }}>
                  <label style={{ fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={form.iconic} onChange={(e) => setForm({ ...form, iconic: e.target.checked })} /> Iconic / flagship</label>
                  <label style={{ fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" checked={form.repetitive} onChange={(e) => setForm({ ...form, repetitive: e.target.checked })} /> Large repetitive package</label>
                </div>
                {(() => {
                  const r = bestRoute(form, team, committedExtra);
                  return (
                    <div style={{ background: C.bg, borderRadius: 8, padding: 12, marginBottom: 16, borderLeft: `5px solid ${r.sc.color}` }}>
                      <div style={{ fontSize: 12, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>Live preview</div>
                      <div style={{ fontWeight: 700, color: r.sc.color, marginTop: 2 }}>{r.sc.tierLabel} · score {r.sc.raw}</div>
                      <div style={{ fontSize: 13, marginTop: 4 }}>
                        {r.top ? <>Recommended: <b>{r.top.name}</b> (fit {r.top.total}/100)</> : "No eligible owner"}
                      </div>
                      <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{r.pathNote}</div>
                    </div>
                  );
                })()}
                <button onClick={addProject} disabled={saving || !form.name.trim()}
                  style={{ background: saving ? C.muted : C.navy, color: "#fff", border: "none", padding: "10px 22px", borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer" }}>
                  {saving ? "Saving…" : "Add to Pipeline"}
                </button>
              </div>
            )}

            {view === "team" && (
              <div style={card}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4, color: C.navy }}>Team Capacity</div>
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
                  Live — includes hours locked in by assignments made on the dashboard.
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  {team.map((t) => {
                    const liveCommitted = t.committed + (committedExtra[t.name] || 0);
                    const util = t.base === 0 ? 0 : Math.round((liveCommitted / t.base) * 100);
                    const avail = t.base - liveCommitted;
                    const col = util >= 90 ? "#A32D2D" : util >= 70 ? "#854F0B" : "#3B6D11";
                    return (
                      <div key={t.name} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <div><b>{t.name}</b> <span style={{ color: C.muted, fontSize: 13 }}>· {t.role}</span></div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: t.base === 0 ? C.muted : col }}>
                            {t.base === 0 ? "unavailable" : util + "% utilised"}
                          </div>
                        </div>
                        {t.base > 0 && (
                          <>
                            <div style={{ height: 8, background: "#eee", borderRadius: 4, marginTop: 6, overflow: "hidden" }}>
                              <div style={{ width: Math.min(util, 100) + "%", height: "100%", background: col }} />
                            </div>
                            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                              {liveCommitted} h committed · {avail} h available of {t.base} h base
                              {committedExtra[t.name] ? ` (+${committedExtra[t.name]} h from new assignments)` : ""}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div style={{ textAlign: "center", fontSize: 11, color: C.muted, marginTop: 10 }}>
        Prototype · transparent scoring engine — recommends, manager decides. Logic from the Signify workbook + strategy deck.
      </div>
    </div>
  );
}
