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
  "Retail/Office/Industry": "Russian Outsourcing",
  Facade: "Local Partner",
  Sports: "Local Partner",
  Road: "Turkish LIAS",
  Tunnel: "Local Partner",
};

const OUTSOURCE_TEAMS = ["Russian Outsourcing", "Turkish LIAS", "Local Partner"];

const TEAM_MEMBERS = ["Tatiana", "Inna", "Vivek", "Farhan", "Nour", "Karim", "Manager Reserve"];

const FIELD = {
  segment: Object.keys(SEGMENT_FIT),
  size: Object.keys(SIZE),
  complexity: Object.keys(COMPLEXITY),
  urgency: Object.keys(URGENCY),
  phase: ["Specification", "Construction"],
};

const STATUS_OPTIONS = ["Not Started", "In Progress", "Completed"];

const STATUS_STYLE = {
  "Not Started": { bg: "#f0f0f0", color: "#5f5f5f" },
  "In Progress": { bg: "#E6F1FB", color: "#0C447C" },
  "Completed":   { bg: "#E8F5E0", color: "#3B6D11" },
};

const OUTSOURCE_STYLE = { bg: "#F3EFF9", color: "#5B3FA0" };

function isOutsourced(assignee) {
  return OUTSOURCE_TEAMS.includes(assignee);
}

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
    const total = Math.round((capacityScore * 0.35 + fitScore * 0.30 + skillScore * 0.20 + iconicScore * 0.15) * 100);
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
    pathNote = `Internal capacity tight — consider outsourcing to: ${SEGMENT_OUTSOURCE[p.segment] || "external support"}.`;
  else if (sc.tier === 1) pathNote = "Tier 1 — keep local, senior QA mandatory.";
  else if (sc.tier === 2 && p.repetitive) pathNote = `Local setup, then outsource to: ${SEGMENT_OUTSOURCE[p.segment]}.`;
  else pathNote = "Local production; partner only on overflow.";
  return { sc, ranked, top, pathNote };
}

export default function ResourceAllocationApp() {
  const [team, setTeam] = useState([]);
  const [projects, setProjects] = useState([]);
  const [assignments, setAssignments] = useState({});
  const [owners, setOwners] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [view, setView] = useState("dashboard");
  const [expanded, setExpanded] = useState(null);
  const [completingId, setCompletingId] = useState(null);
  const [actualHrsInput, setActualHrsInput] = useState("");
  const [editingMember, setEditingMember] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [form, setForm] = useState({
    name: "", phase: "Specification", segment: "Road", size: "Medium",
    complexity: "Medium", iconic: false, urgency: "Specification - Normal",
    repetitive: false, hrs: 20,
  });

  const fetchData = useCallback(async () => {
    const [{ data: proj }, { data: asgn }, { data: tm }] = await Promise.all([
      supabase.from("projects").select("*").order("created_at", { ascending: true }),
      supabase.from("assignments").select("*"),
      supabase.from("team").select("*"),
    ]);
    if (proj) {
      setProjects(proj);
      const ownerMap = {};
      for (const p of proj) if (p.owner) ownerMap[p.id] = p.owner;
      setOwners(ownerMap);
    }
    if (asgn) {
      const map = {};
      for (const a of asgn) map[a.project_id] = a.assignee;
      setAssignments(map);
    }
    if (tm) setTeam(tm);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    const projSub = supabase.channel("projects-channel")
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, fetchData)
      .subscribe();
    const asgnSub = supabase.channel("assignments-channel")
      .on("postgres_changes", { event: "*", schema: "public", table: "assignments" }, fetchData)
      .subscribe();
    const teamSub = supabase.channel("team-channel")
      .on("postgres_changes", { event: "*", schema: "public", table: "team" }, fetchData)
      .subscribe();
    return () => {
      supabase.removeChannel(projSub);
      supabase.removeChannel(asgnSub);
      supabase.removeChannel(teamSub);
    };
  }, [fetchData]);

  // Only active non-outsourced assignments consume internal team capacity
  const committedExtra = useMemo(() => {
    const m = {};
    for (const p of projects) {
      if (p.status === "Completed") continue;
      const who = assignments[p.id];
      if (who && !isOutsourced(who)) m[who] = (m[who] || 0) + Number(p.hrs || 0);
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

  const stats = useMemo(() => {
    const active = scored.filter((p) => p.status !== "Completed");
    const completed = scored.filter((p) => p.status === "Completed");
    const internal = active.filter((p) => !isOutsourced(assignments[p.id]));
    const russian = active.filter((p) => assignments[p.id] === "Russian Outsourcing");
    const turkish = active.filter((p) => assignments[p.id] === "Turkish LIAS");
    const totalEstimated = completed.reduce((a, p) => a + Number(p.hrs || 0), 0);
    const totalActual = completed.reduce((a, p) => a + Number(p.actual_hrs || 0), 0);
    return {
      open: active.length,
      internal: internal.length,
      russian: russian.length,
      turkish: turkish.length,
      tier1: active.filter((p) => p.tier === 1).length,
      totalHrs: active.reduce((a, p) => a + Number(p.hrs || 0), 0),
      completed: completed.length,
      accuracy: totalEstimated > 0 ? Math.round((totalActual / totalEstimated) * 100) : null,
    };
  }, [scored, assignments, projects]);

  async function addProject() {
    if (!form.name.trim()) return;
    setSaving(true);
    const nextId = "P-" + String(projects.length + 1).padStart(3, "0");
    await supabase.from("projects").insert({
      id: nextId, name: form.name, phase: form.phase, segment: form.segment,
      size: form.size, complexity: form.complexity, iconic: form.iconic,
      urgency: form.urgency, repetitive: form.repetitive, hrs: Number(form.hrs),
      status: "Not Started",
    });
    setForm({ ...form, name: "" });
    setSaving(false);
    setView("dashboard");
  }

  async function assignPerson(projectId, assigneeName) {
    setAssignments((prev) => ({ ...prev, [projectId]: assigneeName }));
    await supabase.from("assignments").upsert({ project_id: projectId, assignee: assigneeName });
    const proj = projects.find(p => p.id === projectId);
    if (proj && proj.status === "Not Started") {
      await supabase.from("projects").update({ status: "In Progress" }).eq("id", projectId);
    }
  }

  async function setOwner(projectId, ownerName) {
    setOwners((prev) => ({ ...prev, [projectId]: ownerName }));
    await supabase.from("projects").update({ owner: ownerName }).eq("id", projectId);
  }

  async function updateStatus(projectId, newStatus) {
    if (newStatus === "Completed") {
      setCompletingId(projectId);
      setActualHrsInput("");
      return;
    }
    await supabase.from("projects").update({ status: newStatus }).eq("id", projectId);
  }

  async function submitCompletion(projectId) {
    const actual = Number(actualHrsInput);
    if (!actual || actual <= 0) return;
    await supabase.from("projects").update({ status: "Completed", actual_hrs: actual }).eq("id", projectId);
    setCompletingId(null);
    setActualHrsInput("");
  }

  function startEdit(member) {
    setEditingMember(member.name);
    setEditForm({ base: member.base, committed: member.committed });
  }

  async function saveEdit(memberName) {
    await supabase.from("team").update({
      base: Number(editForm.base),
      committed: Number(editForm.committed),
    }).eq("name", memberName);
    setEditingMember(null);
  }

  const C = { navy: "#1F3864", accent: "#2E75B6", ink: "#1a1a1a", muted: "#5f5f5f", line: "#e3e3e3", bg: "#f7f8fa", card: "#fff" };
  const wrap = { fontFamily: "Segoe UI, Helvetica, Arial, sans-serif", color: C.ink, background: C.bg, minHeight: "100vh", padding: "0 0 40px" };
  const tabStyle = (a) => ({ padding: "10px 18px", border: "none", cursor: "pointer", fontSize: 14, fontWeight: a ? 600 : 400, color: a ? "#fff" : C.navy, background: a ? C.navy : "transparent", borderRadius: 6 });
  const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 18 };
  const labelStyle = { fontSize: 12, fontWeight: 600, color: C.muted, display: "block", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.4 };
  const inputStyle = { width: "100%", padding: "8px 10px", border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 14, boxSizing: "border-box" };
  const barColor = (v) => (v >= 70 ? "#3B6D11" : v >= 45 ? "#854F0B" : "#A32D2D");

  const activeProjects = scored.filter(p => p.status !== "Completed").sort((a, b) => b.raw - a.raw);
  const completedProjects = scored.filter(p => p.status === "Completed").sort((a, b) => b.raw - a.raw);
  const internalProjects = activeProjects.filter(p => !isOutsourced(assignments[p.id]));
  const russianProjects = activeProjects.filter(p => assignments[p.id] === "Russian Outsourcing");
  const turkishProjects = activeProjects.filter(p => assignments[p.id] === "Turkish LIAS");
  const outsourcedProjects = activeProjects.filter(p => isOutsourced(assignments[p.id]));

  function renderProjectCard(p, showOutsourceSection = false) {
    const open = expanded === p.id;
    const chosen = assignments[p.id];
    const owner = owners[p.id];
    const st = STATUS_STYLE[p.status] || STATUS_STYLE["Not Started"];
    const isCompleting = completingId === p.id;
    const chosenIsOutsourced = isOutsourced(chosen);

    return (
      <div key={p.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "12px 14px", borderLeft: `5px solid ${p.color}` }}>
        {/* Header row */}
        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
            <b>{p.id}</b>
            <span>{p.name}</span>
            {p.iconic && <span style={{ fontSize: 11, background: "#FAEEDA", color: "#854F0B", padding: "2px 8px", borderRadius: 10, fontWeight: 600 }}>ICONIC</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, background: st.bg, color: st.color, padding: "3px 10px", borderRadius: 10, fontWeight: 600 }}>{p.status}</span>
            <select value={p.status} onChange={(e) => updateStatus(p.id, e.target.value)}
              style={{ fontSize: 12, padding: "3px 6px", border: `1px solid ${C.line}`, borderRadius: 5, cursor: "pointer" }}>
              {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {/* Meta row */}
        <div style={{ fontSize: 13, color: C.muted, marginTop: 6, display: "flex", flexWrap: "wrap", gap: 14 }}>
          <span>{p.segment} · {p.phase}</span>
          <span>{p.size} · {p.complexity}</span>
          <span>{p.urgency}</span>
          <span style={{ fontWeight: 600 }}>Est. {p.hrs} h</span>
          <span style={{ fontWeight: 700, color: p.color }}>{p.tierLabel} · score {p.raw}</span>
        </div>

        {/* Ownership row */}
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", padding: "7px 10px", background: "#F8F6FD", borderRadius: 6, border: "1px solid #E0D9F5" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "#5B3FA0" }}>Owner:</span>
            <select
              value={owner || ""}
              onChange={(e) => setOwner(p.id, e.target.value)}
              style={{ fontSize: 12, padding: "3px 8px", border: "1px solid #C9BCF0", borderRadius: 5, background: "#fff", cursor: "pointer", color: owner ? C.ink : C.muted }}
            >
              <option value="">— assign owner —</option>
              {TEAM_MEMBERS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          {owner && (
            <span style={{ fontSize: 12, color: "#5B3FA0" }}>
              <b>{owner}</b> is responsible for oversight
            </span>
          )}
          {chosenIsOutsourced && !owner && (
            <span style={{ fontSize: 12, color: "#A32D2D", fontWeight: 600 }}>⚠ Outsourced project needs an owner</span>
          )}
        </div>

        {/* Completion form */}
        {isCompleting && (
          <div style={{ marginTop: 10, background: "#E8F5E0", border: "1px solid #b6d9a0", borderRadius: 8, padding: 12 }}>
            <div style={{ fontWeight: 600, color: "#3B6D11", marginBottom: 6 }}>Mark as Completed — enter actual hours</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="number" placeholder="Actual hours" value={actualHrsInput}
                onChange={(e) => setActualHrsInput(e.target.value)}
                style={{ width: 140, padding: "7px 10px", border: "1px solid #b6d9a0", borderRadius: 6, fontSize: 14 }} />
              <button onClick={() => submitCompletion(p.id)}
                style={{ background: "#3B6D11", color: "#fff", border: "none", borderRadius: 6, padding: "7px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                Confirm Complete
              </button>
              <button onClick={() => setCompletingId(null)}
                style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 6, padding: "7px 12px", fontSize: 13, cursor: "pointer" }}>
                Cancel
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#3B6D11", marginTop: 4 }}>
              Estimated: {p.hrs} h —{" "}
              {Number(actualHrsInput) > 0
                ? Number(actualHrsInput) > p.hrs
                  ? `+${Number(actualHrsInput) - p.hrs} h over estimate`
                  : `-${p.hrs - Number(actualHrsInput)} h under estimate`
                : "enter actual hours above"}
            </div>
          </div>
        )}

        {/* Recommendation / assignment panel */}
        <div style={{ marginTop: 8, padding: "8px 10px", background: C.bg, borderRadius: 6, fontSize: 13 }}>
          {chosen ? (
            <div style={{ marginBottom: 4 }}>
              <b style={{ color: C.navy }}>Assigned to:</b>{" "}
              <span style={{
                background: chosenIsOutsourced ? OUTSOURCE_STYLE.bg : "#E6F1FB",
                color: chosenIsOutsourced ? OUTSOURCE_STYLE.color : "#0C447C",
                padding: "1px 8px", borderRadius: 8, fontWeight: 600, fontSize: 12,
              }}>{chosen}</span>
            </div>
          ) : (
            p.route.top ? (
              <>
                <b style={{ color: C.navy }}>Recommended:</b> {p.route.top.name}
                <span style={{ marginLeft: 6, fontSize: 12, background: "#E6F1FB", color: "#0C447C", padding: "1px 7px", borderRadius: 8, fontWeight: 600 }}>
                  fit {p.route.top.total}/100
                </span>
                <div style={{ color: C.muted, marginTop: 3 }}>{p.route.pathNote}</div>
              </>
            ) : <span style={{ color: "#A32D2D" }}>{p.route.pathNote}</span>
          )}

          <button onClick={() => setExpanded(open ? null : p.id)}
            style={{ marginTop: 6, background: "none", border: `1px solid ${C.line}`, borderRadius: 5, padding: "3px 9px", fontSize: 12, cursor: "pointer", color: C.navy }}>
            {open ? "Hide ranking" : "Assign / change assignment"}
          </button>

          {open && (
            <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
              {/* Internal team ranking */}
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

              {/* Outsource team options */}
              <div style={{ marginTop: 4, padding: "8px 10px", background: "#F8F6FD", borderRadius: 6, border: "1px solid #E0D9F5" }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: OUTSOURCE_STYLE.color, marginBottom: 6 }}>Outsource to external team</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {OUTSOURCE_TEAMS.map(ot => (
                    <button key={ot} onClick={() => assignPerson(p.id, ot)}
                      style={{ background: chosen === ot ? OUTSOURCE_STYLE.color : "transparent", color: chosen === ot ? "#fff" : OUTSOURCE_STYLE.color, border: `1px solid ${OUTSOURCE_STYLE.color}`, borderRadius: 5, padding: "4px 12px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                      {chosen === ot ? `${ot} ✓` : ot}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 5 }}>
                  Suggested for this segment: <b style={{ color: OUTSOURCE_STYLE.color }}>{SEGMENT_OUTSOURCE[p.segment]}</b>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

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
        <button style={tabStyle(view === "completed")} onClick={() => setView("completed")}>
          Completed {stats.completed > 0 && `(${stats.completed})`}
        </button>
      </div>

      <div style={{ padding: "22px 28px", maxWidth: 1000, margin: "0 auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 60, color: C.muted, fontSize: 15 }}>Loading…</div>
        ) : (
          <>
            {view === "dashboard" && (
              <>
                {/* Stats */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12, marginBottom: 20 }}>
                  {[
                    ["Active projects", stats.open],
                    ["Tier 1 — Critical", stats.tier1],
                    ["Internal team", stats.internal],
                    ["Russian Outsourcing", stats.russian],
                    ["Turkish LIAS", stats.turkish],
                  ].map(([k, v]) => (
                    <div key={k} style={{ ...card, padding: 14 }}>
                      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>{k}</div>
                      <div style={{ fontSize: 26, fontWeight: 700, color: C.navy, marginTop: 4 }}>{v}</div>
                    </div>
                  ))}
                </div>

                {/* Internal projects */}
                <div style={{ ...card, marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: C.navy }}>
                    Internal Team Projects ({internalProjects.length})
                  </div>
                  {internalProjects.length === 0 ? (
                    <div style={{ color: C.muted, textAlign: "center", padding: 30 }}>No internal projects — add one via New Project Intake.</div>
                  ) : (
                    <div style={{ display: "grid", gap: 10 }}>
                      {internalProjects.map(p => renderProjectCard(p))}
                    </div>
                  )}
                </div>

                {/* Russian Outsourcing projects */}
                <div style={{ ...card, marginBottom: 16 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: OUTSOURCE_STYLE.color, display: "flex", alignItems: "center", gap: 8 }}>
                    <span>🇷🇺</span> Russian Outsourcing Team ({russianProjects.length})
                  </div>
                  {russianProjects.length === 0 ? (
                    <div style={{ color: C.muted, textAlign: "center", padding: 30 }}>No projects assigned to Russian Outsourcing.</div>
                  ) : (
                    <div style={{ display: "grid", gap: 10 }}>
                      {russianProjects.map(p => renderProjectCard(p, true))}
                    </div>
                  )}
                </div>

                {/* Turkish LIAS projects */}
                <div style={card}>
                  <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 12, color: OUTSOURCE_STYLE.color, display: "flex", alignItems: "center", gap: 8 }}>
                    <span>🇹🇷</span> Turkish LIAS Team ({turkishProjects.length})
                  </div>
                  {turkishProjects.length === 0 ? (
                    <div style={{ color: C.muted, textAlign: "center", padding: 30 }}>No projects assigned to Turkish LIAS.</div>
                  ) : (
                    <div style={{ display: "grid", gap: 10 }}>
                      {turkishProjects.map(p => renderProjectCard(p, true))}
                    </div>
                  )}
                </div>
              </>
            )}

            {view === "completed" && (
              <div style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, color: C.navy }}>Completed Projects</div>
                  {stats.accuracy !== null && (
                    <div style={{ fontSize: 13, color: C.muted }}>
                      Estimation accuracy:{" "}
                      <b style={{ color: stats.accuracy <= 110 && stats.accuracy >= 90 ? "#3B6D11" : "#A32D2D" }}>
                        {stats.accuracy}%
                      </b>
                      <span style={{ fontSize: 11, marginLeft: 4 }}>(actual / estimated)</span>
                    </div>
                  )}
                </div>
                {completedProjects.length === 0 ? (
                  <div style={{ color: C.muted, textAlign: "center", padding: 40 }}>No completed projects yet.</div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {completedProjects.map((p) => {
                      const chosen = assignments[p.id];
                      const owner = owners[p.id];
                      const diff = p.actual_hrs - p.hrs;
                      const diffColor = diff > 0 ? "#A32D2D" : "#3B6D11";
                      return (
                        <div key={p.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "12px 14px", borderLeft: "5px solid #3B6D11" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <b>{p.id}</b><span>{p.name}</span>
                              {p.iconic && <span style={{ fontSize: 11, background: "#FAEEDA", color: "#854F0B", padding: "2px 8px", borderRadius: 10, fontWeight: 600 }}>ICONIC</span>}
                              <span style={{ fontSize: 11, background: "#E8F5E0", color: "#3B6D11", padding: "2px 8px", borderRadius: 10, fontWeight: 600 }}>COMPLETED</span>
                            </div>
                            <div style={{ fontSize: 13, color: C.muted }}>{p.segment} · {p.phase}</div>
                          </div>
                          <div style={{ marginTop: 8, display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13 }}>
                            <span>Executed by: <b style={{ color: isOutsourced(chosen) ? OUTSOURCE_STYLE.color : C.navy }}>{chosen || "—"}</b></span>
                            {owner && <span>Owner: <b style={{ color: "#5B3FA0" }}>{owner}</b></span>}
                            <span>Estimated: <b>{p.hrs} h</b></span>
                            <span>Actual: <b>{p.actual_hrs} h</b></span>
                            <span style={{ color: diffColor, fontWeight: 600 }}>
                              {diff > 0 ? `+${diff} h over` : `${Math.abs(diff)} h under`} estimate
                            </span>
                          </div>
                          <div style={{ marginTop: 6, height: 6, background: "#eee", borderRadius: 4, overflow: "hidden", maxWidth: 300 }}>
                            <div style={{ width: Math.min((p.actual_hrs / p.hrs) * 100, 150) + "%", height: "100%", background: diff > 0 ? "#A32D2D" : "#3B6D11" }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
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
                  Live — completed projects automatically free up capacity. Click <b>Edit</b> to update hours.
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  {team.map((t) => {
                    const assignedHrs = committedExtra[t.name] || 0;
                    const liveCommitted = t.committed + assignedHrs;
                    const util = t.base === 0 ? 0 : Math.round((liveCommitted / t.base) * 100);
                    const avail = t.base - liveCommitted;
                    const col = util >= 90 ? "#A32D2D" : util >= 70 ? "#854F0B" : "#3B6D11";
                    const isEditing = editingMember === t.name;
                    const minCommitted = assignedHrs;
                    const editCommittedNum = Number(editForm.committed);
                    const editBaseNum = Number(editForm.base);
                    const committedTooLow = isEditing && editCommittedNum < minCommitted;
                    const committedTooHigh = isEditing && editCommittedNum > editBaseNum;
                    const saveBlocked = committedTooLow || committedTooHigh;

                    return (
                      <div key={t.name} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 14px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div><b>{t.name}</b> <span style={{ color: C.muted, fontSize: 13 }}>· {t.role}</span></div>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <div style={{ fontSize: 13, fontWeight: 600, color: t.base === 0 ? C.muted : col }}>
                              {t.base === 0 ? "unavailable" : util + "% utilised"}
                            </div>
                            {!isEditing && (
                              <button onClick={() => startEdit(t)}
                                style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 5, padding: "3px 10px", fontSize: 12, cursor: "pointer", color: C.navy }}>
                                Edit
                              </button>
                            )}
                          </div>
                        </div>

                        {isEditing ? (
                          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            <div>
                              <label style={labelStyle}>Base hours / week</label>
                              <input type="number" style={inputStyle} value={editForm.base}
                                onChange={(e) => setEditForm({ ...editForm, base: e.target.value })} />
                            </div>
                            <div>
                              <label style={labelStyle}>
                                Committed hours (min {minCommitted}, max {editForm.base})
                              </label>
                              <input
                                type="number"
                                style={{ ...inputStyle, borderColor: saveBlocked ? "#A32D2D" : C.line }}
                                value={editForm.committed}
                                min={minCommitted}
                                max={editForm.base}
                                onChange={(e) => {
                                  const val = Math.max(minCommitted, Math.min(editBaseNum, Number(e.target.value)));
                                  setEditForm({ ...editForm, committed: val });
                                }}
                              />
                              {committedTooLow && (
                                <div style={{ fontSize: 11, color: "#A32D2D", marginTop: 3 }}>
                                  Cannot go below {minCommitted} h — {t.name} has active projects totalling {minCommitted} h
                                </div>
                              )}
                              {committedTooHigh && (
                                <div style={{ fontSize: 11, color: "#A32D2D", marginTop: 3 }}>
                                  Cannot exceed base hours ({editForm.base} h)
                                </div>
                              )}
                            </div>
                            <div style={{ display: "flex", gap: 8, gridColumn: "span 2" }}>
                              <button onClick={() => saveEdit(t.name)} disabled={saveBlocked}
                                style={{ background: saveBlocked ? C.muted : C.navy, color: "#fff", border: "none", borderRadius: 5, padding: "6px 16px", fontSize: 13, cursor: saveBlocked ? "not-allowed" : "pointer", fontWeight: 600 }}>
                                Save
                              </button>
                              <button onClick={() => setEditingMember(null)}
                                style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 5, padding: "6px 14px", fontSize: 13, cursor: "pointer" }}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          t.base > 0 && (
                            <>
                              <div style={{ height: 8, background: "#eee", borderRadius: 4, marginTop: 6, overflow: "hidden" }}>
                                <div style={{ width: Math.min(util, 100) + "%", height: "100%", background: col }} />
                              </div>
                              <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                                {liveCommitted} h committed · {avail} h available of {t.base} h base
                                {assignedHrs > 0 ? ` (${assignedHrs} h locked by active projects)` : ""}
                              </div>
                            </>
                          )
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
