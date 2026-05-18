import React, { useState, useMemo, useEffect, useCallback } from "react";
import { supabase } from "./supabase";
import { exportToExcel } from "./exportToExcel";

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
  else if (p.iconic) pathNote = "Iconic project — must stay internal. Cannot be outsourced.";
  else if (top.total < 45 || (top.available <= 0 && sc.tier !== 1))
    pathNote = `Internal capacity tight — consider outsourcing to: ${SEGMENT_OUTSOURCE[p.segment] || "external support"}.`;
  else if (sc.tier === 1) pathNote = "Tier 1 — keep local, senior QA mandatory.";
  else if (sc.tier === 2 && p.repetitive) pathNote = `Local setup, then outsource to: ${SEGMENT_OUTSOURCE[p.segment]}.`;
  else pathNote = "Local production; partner only on overflow.";
  return { sc, ranked, top, pathNote };
}

// For iconic projects with insufficient capacity: find which active non-iconic project
// assigned to the recommended person can be moved out to free up space.
function getRebalancingSuggestion(p, projects, assignments) {
  if (!p.iconic) return null;
  const top = p.route?.top;
  if (!top) return null;
  if (top.available >= p.hrs) return null; // enough room — no rebalancing needed

  const hoursNeeded = p.hrs - top.available;

  const candidates = projects.filter(proj =>
    proj.status !== "Completed" &&
    !proj.iconic &&
    assignments[proj.id] === top.name &&
    proj.id !== p.id &&
    SEGMENT_OUTSOURCE[proj.segment]
  );
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => b.hrs - a.hrs);
  const pick = candidates.find(proj => proj.hrs >= hoursNeeded) || candidates[0];

  return {
    person: top.name,
    project: pick,
    suggestedTeam: SEGMENT_OUTSOURCE[pick.segment],
    hoursFreed: pick.hrs,
    hoursNeeded,
  };
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
  const [pendingRebalance, setPendingRebalance] = useState(null);
  const [pendingOutsource, setPendingOutsource] = useState(null);
  const [calMonth, setCalMonth] = useState(() => { const d = new Date(); d.setDate(1); return d; });
  // overloadFlow: null | { step, newProjectId, newProjectName, newProjectHrs, targetPerson, theirProjects, pickedProjectId?, pickedProjectName?, newAssignee? }
  const [overloadFlow, setOverloadFlow] = useState(null);
  const [exportLoading, setExportLoading] = useState(false);
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

  async function assignPerson(projectId, assigneeName, recommendedOwner) {
    const owner = isOutsourced(assigneeName) ? (recommendedOwner || null) : assigneeName;
    const today = new Date().toISOString().split("T")[0];

    // Calculate expected delivery: hrs / available-hrs-per-week → weeks → date
    let expectedDelivery = null;
    if (!isOutsourced(assigneeName)) {
      const member = team.find(t => t.name === assigneeName);
      if (member && member.base > 0) {
        const proj = projects.find(p => p.id === projectId);
        const liveCommitted = member.committed + (committedExtra[assigneeName] || 0);
        const availablePerWeek = Math.max(1, member.base - liveCommitted);
        const weeksNeeded = Math.ceil((proj?.hrs || 1) / availablePerWeek);
        const delivery = new Date();
        delivery.setDate(delivery.getDate() + weeksNeeded * 7);
        expectedDelivery = delivery.toISOString().split("T")[0];
      }
    }

    setAssignments((prev) => ({ ...prev, [projectId]: assigneeName }));
    setOwners((prev) => ({ ...prev, [projectId]: owner }));
    await supabase.from("assignments").upsert({ project_id: projectId, assignee: assigneeName });

    const proj = projects.find(p => p.id === projectId);
    const updates = { owner, assigned_date: today };
    if (expectedDelivery) updates.expected_delivery_date = expectedDelivery;
    if (proj && proj.status === "Not Started") updates.status = "In Progress";
    await supabase.from("projects").update(updates).eq("id", projectId);
  }

  // Pre-check before assigning internally — detects overload and triggers the flow
  function tryAssignPerson(projectId, assigneeName, recommendedOwner) {
    const member = team.find(t => t.name === assigneeName);
    if (!member || member.base === 0) return;
    const proj = projects.find(p => p.id === projectId);
    const liveCommitted = member.committed + (committedExtra[assigneeName] || 0);
    const wouldExceed = liveCommitted + (proj?.hrs || 0) > member.base;
    if (wouldExceed) {
      const theirProjects = projects.filter(p =>
        p.status !== "Completed" &&
        assignments[p.id] === assigneeName &&
        p.id !== projectId
      );
      setOverloadFlow({
        step: "confirm",
        newProjectId: projectId,
        newProjectName: proj?.name,
        newProjectHrs: proj?.hrs || 0,
        targetPerson: assigneeName,
        theirProjects,
      });
    } else {
      assignPerson(projectId, assigneeName, recommendedOwner);
    }
  }

  // Execute the final swap: reassign pickedProject to newAssignee, then assign newProject to targetPerson
  async function executeRebalance() {
    const { newProjectId, targetPerson, pickedProjectId, newAssignee } = overloadFlow;
    // Reassign the picked project to the new assignee — ownership transfers
    await assignPerson(pickedProjectId, newAssignee, newAssignee);
    // Now assign the incoming project to the originally intended person
    await assignPerson(newProjectId, targetPerson, targetPerson);
    setOverloadFlow(null);
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
    const today = new Date().toISOString().split("T")[0];
    await supabase.from("projects").update({
      status: "Completed",
      actual_hrs: actual,
      actual_delivery_date: today,
    }).eq("id", projectId);
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
    const rebalance = getRebalancingSuggestion(p, projects, assignments);

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

        {/* Date tabs */}
        <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[
            { label: "Assigned Date",          value: p.assigned_date,          dot: "#2E75B6" },
            { label: "Expected Delivery",       value: p.expected_delivery_date,  dot: "#854F0B" },
            { label: "Actual Delivery",         value: p.actual_delivery_date,    dot: "#3B6D11" },
          ].map(({ label, value, dot }) => (
            <div key={label} style={{ display: "flex", flexDirection: "column", border: `1px solid ${C.line}`, borderRadius: 7, padding: "5px 10px", minWidth: 140, background: "#fff" }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: dot, textTransform: "uppercase", letterSpacing: 0.5, display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: dot, display: "inline-block" }} />
                {label}
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: value ? C.ink : C.muted, marginTop: 2 }}>
                {value || "—"}
              </span>
            </div>
          ))}
        </div>

        {/* Ownership row — read only, auto-set on assignment */}
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", padding: "7px 10px", background: "#F8F6FD", borderRadius: 6, border: "1px solid #E0D9F5" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "#5B3FA0" }}>Owner:</span>
          {owner ? (
            <>
              <span style={{ fontSize: 12, background: "#E0D9F5", color: "#5B3FA0", padding: "2px 10px", borderRadius: 8, fontWeight: 700 }}>{owner}</span>
              <span style={{ fontSize: 12, color: C.muted }}>
                {chosenIsOutsourced ? "— internal oversight of outsourced delivery" : "— responsible for design delivery"}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 12, color: C.muted, fontStyle: "italic" }}>
              Set automatically when project is assigned
            </span>
          )}
        </div>

        {/* Rebalancing alert — iconic projects with insufficient capacity */}
        {rebalance && !chosen && (
          <div style={{ marginTop: 8, background: "#FFF8E1", border: "1px solid #F9A825", borderRadius: 8, padding: 12 }}>
            <div style={{ fontWeight: 700, color: "#7B5E00", fontSize: 13, marginBottom: 4 }}>
              Iconic project — cannot be outsourced
            </div>
            <div style={{ fontSize: 13, color: "#5C4200", marginBottom: 8 }}>
              <b>{rebalance.person}</b> needs <b>{rebalance.hoursNeeded} h</b> freed up to take this on.
              Suggested: move <b>{rebalance.project.name}</b> ({rebalance.project.hrs} h, non-iconic)
              to <b>{rebalance.suggestedTeam}</b>.
            </div>

            {pendingRebalance?.projectId === rebalance.project.id ? (
              /* Confirmation step */
              <div style={{ background: "#FFF3CD", border: "1px solid #F9A825", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#7B5E00", marginBottom: 8 }}>
                  Confirm: move <b>{rebalance.project.id} — {rebalance.project.name}</b> to <b>{rebalance.suggestedTeam}</b>?
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={async () => {
                      await assignPerson(rebalance.project.id, rebalance.suggestedTeam, rebalance.person);
                      setPendingRebalance(null);
                    }}
                    style={{ background: "#7B5E00", color: "#fff", border: "none", borderRadius: 6, padding: "6px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                    Yes, apply rebalancing
                  </button>
                  <button
                    onClick={() => setPendingRebalance(null)}
                    style={{ background: "none", border: "1px solid #F9A825", borderRadius: 6, padding: "6px 14px", fontSize: 13, cursor: "pointer", color: "#7B5E00" }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setPendingRebalance({ projectId: rebalance.project.id })}
                style={{ background: "#F9A825", color: "#fff", border: "none", borderRadius: 6, padding: "6px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>
                Suggest — move {rebalance.project.id} to {rebalance.suggestedTeam}
              </button>
            )}

            <div style={{ fontSize: 11, color: "#7B5E00", marginTop: 6 }}>
              This would free {rebalance.hoursFreed} h from {rebalance.person}, making room for this iconic project.
            </div>
          </div>
        )}

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
                  <button onClick={() => tryAssignPerson(p.id, r.name, p.route.top?.name)}
                    style={{ marginTop: 5, background: chosen === r.name ? C.navy : "transparent", color: chosen === r.name ? "#fff" : C.navy, border: `1px solid ${C.navy}`, borderRadius: 5, padding: "3px 11px", fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                    {chosen === r.name ? "Assigned ✓" : "Assign"}
                  </button>
                </div>
              ))}

              {/* Outsource team options — blocked for iconic projects */}
              {p.iconic ? (
                <div style={{ marginTop: 4, padding: "8px 10px", background: "#FFF8E1", borderRadius: 6, border: "1px solid #F9A825" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#7B5E00" }}>
                    Outsourcing not allowed — iconic project must stay internal
                  </div>
                </div>
              ) : (
                <div style={{ marginTop: 4, padding: "8px 10px", background: "#F8F6FD", borderRadius: 6, border: "1px solid #E0D9F5" }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: OUTSOURCE_STYLE.color, marginBottom: 6 }}>Outsource to external team</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {OUTSOURCE_TEAMS.map(ot => (
                      <button key={ot}
                        onClick={() => chosen === ot ? null : setPendingOutsource({ projectId: p.id, team: ot, suggestedOwner: p.route.top?.name })}
                        style={{ background: chosen === ot ? OUTSOURCE_STYLE.color : "transparent", color: chosen === ot ? "#fff" : OUTSOURCE_STYLE.color, border: `1px solid ${OUTSOURCE_STYLE.color}`, borderRadius: 5, padding: "4px 12px", fontSize: 12, cursor: chosen === ot ? "default" : "pointer", fontWeight: 600 }}>
                        {chosen === ot ? `${ot} ✓` : ot}
                      </button>
                    ))}
                  </div>

                  {/* Owner selection prompt for outsource assignment */}
                  {pendingOutsource?.projectId === p.id && (
                    <div style={{ marginTop: 10, background: "#fff", border: "1px solid #C9BCF0", borderRadius: 6, padding: "10px 12px" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#5B3FA0", marginBottom: 6 }}>
                        Who will own and oversee this project internally?
                      </div>
                      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
                        Suggested: <b>{pendingOutsource.suggestedOwner || "—"}</b> (top recommendation)
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                        {TEAM_MEMBERS.map(m => (
                          <button key={m}
                            onClick={() => setPendingOutsource(prev => ({ ...prev, selectedOwner: m }))}
                            style={{
                              background: pendingOutsource.selectedOwner === m ? "#5B3FA0" : "#F8F6FD",
                              color: pendingOutsource.selectedOwner === m ? "#fff" : "#5B3FA0",
                              border: "1px solid #C9BCF0", borderRadius: 5, padding: "4px 12px",
                              fontSize: 12, cursor: "pointer", fontWeight: 600,
                            }}>
                            {m}
                          </button>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          disabled={!pendingOutsource.selectedOwner}
                          onClick={async () => {
                            await assignPerson(pendingOutsource.projectId, pendingOutsource.team, pendingOutsource.selectedOwner);
                            setPendingOutsource(null);
                          }}
                          style={{ background: pendingOutsource.selectedOwner ? "#5B3FA0" : C.muted, color: "#fff", border: "none", borderRadius: 6, padding: "6px 16px", fontSize: 13, fontWeight: 700, cursor: pendingOutsource.selectedOwner ? "pointer" : "not-allowed" }}>
                          Confirm assignment
                        </button>
                        <button onClick={() => setPendingOutsource(null)}
                          style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 6, padding: "6px 14px", fontSize: 13, cursor: "pointer" }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  <div style={{ fontSize: 11, color: C.muted, marginTop: 5 }}>
                    Suggested for this segment: <b style={{ color: OUTSOURCE_STYLE.color }}>{SEGMENT_OUTSOURCE[p.segment]}</b>
                  </div>
                </div>
              )}
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
        <button style={tabStyle(view === "calendar")} onClick={() => setView("calendar")}>Calendar</button>
        <button style={tabStyle(view === "export")} onClick={() => setView("export")}>Export to Excel</button>
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
                          <div style={{ marginTop: 6, display: "flex", gap: 20, flexWrap: "wrap", fontSize: 12, color: C.muted }}>
                            {p.assigned_date && <span><span style={{ color: "#2E75B6", fontWeight: 600 }}>▶ Assigned:</span> {p.assigned_date}</span>}
                            {p.expected_delivery_date && <span><span style={{ color: "#854F0B", fontWeight: 600 }}>⏱ Expected:</span> {p.expected_delivery_date}</span>}
                            {p.actual_delivery_date && <span><span style={{ color: "#3B6D11", fontWeight: 600 }}>✓ Delivered:</span> {p.actual_delivery_date}</span>}
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

            {view === "calendar" && (() => {
              const year = calMonth.getFullYear();
              const month = calMonth.getMonth();
              const monthName = calMonth.toLocaleString("default", { month: "long", year: "numeric" });
              const firstDay = new Date(year, month, 1).getDay();
              const daysInMonth = new Date(year, month + 1, 0).getDate();
              const todayStr = new Date().toISOString().split("T")[0];

              // Build map: dateStr → list of events
              const eventMap = {};
              const addEvent = (dateStr, event) => {
                if (!dateStr) return;
                if (!eventMap[dateStr]) eventMap[dateStr] = [];
                eventMap[dateStr].push(event);
              };
              for (const p of projects) {
                const assignee = assignments[p.id];
                const owner = owners[p.id];
                if (p.assigned_date) addEvent(p.assigned_date, { type: "assigned", label: p.id, name: p.name, assignee, color: "#2E75B6" });
                if (p.expected_delivery_date && p.status !== "Completed") addEvent(p.expected_delivery_date, { type: "expected", label: p.id, name: p.name, assignee: owner || assignee, color: "#854F0B" });
                if (p.actual_delivery_date) addEvent(p.actual_delivery_date, { type: "actual", label: p.id, name: p.name, assignee: owner || assignee, color: "#3B6D11" });
              }

              const cells = [];
              for (let i = 0; i < (firstDay === 0 ? 6 : firstDay - 1); i++) cells.push(null);
              for (let d = 1; d <= daysInMonth; d++) cells.push(d);

              return (
                <div style={card}>
                  {/* Navigation */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <button onClick={() => setCalMonth(new Date(year, month - 1, 1))}
                      style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontSize: 16 }}>‹</button>
                    <div style={{ fontWeight: 700, fontSize: 16, color: C.navy }}>{monthName}</div>
                    <button onClick={() => setCalMonth(new Date(year, month + 1, 1))}
                      style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontSize: 16 }}>›</button>
                  </div>

                  {/* Legend */}
                  <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 12 }}>
                    {[["#2E75B6", "Date assigned"], ["#854F0B", "Expected delivery"], ["#3B6D11", "Actual delivery"]].map(([col, lbl]) => (
                      <span key={lbl} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ width: 10, height: 10, borderRadius: "50%", background: col, display: "inline-block" }} />
                        {lbl}
                      </span>
                    ))}
                  </div>

                  {/* Day headers */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, marginBottom: 2 }}>
                    {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => (
                      <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, color: C.muted, padding: "4px 0" }}>{d}</div>
                    ))}
                  </div>

                  {/* Calendar grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
                    {cells.map((day, i) => {
                      if (!day) return <div key={`empty-${i}`} />;
                      const dateStr = `${year}-${String(month + 1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
                      const events = eventMap[dateStr] || [];
                      const isToday = dateStr === todayStr;
                      return (
                        <div key={dateStr} style={{
                          minHeight: 72, border: `1px solid ${isToday ? C.navy : C.line}`,
                          borderRadius: 6, padding: "4px 5px",
                          background: isToday ? "#EEF2F8" : "#fff",
                        }}>
                          <div style={{ fontSize: 12, fontWeight: isToday ? 700 : 400, color: isToday ? C.navy : C.ink, marginBottom: 2 }}>{day}</div>
                          {events.map((ev, j) => (
                            <div key={j} title={`${ev.name} — ${ev.type === "assigned" ? "Assigned" : ev.type === "expected" ? "Expected delivery" : "Delivered"}: ${ev.assignee || ""}`}
                              style={{ fontSize: 10, background: ev.color + "22", color: ev.color, borderLeft: `3px solid ${ev.color}`, borderRadius: 3, padding: "1px 4px", marginBottom: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: 600 }}>
                              {ev.label} {ev.type === "assigned" ? "▶" : ev.type === "expected" ? "⏱" : "✓"}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

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

            {view === "export" && (
              <div style={card}>
                <div style={{ fontWeight: 700, fontSize: 16, color: C.navy, marginBottom: 6 }}>Export Data to Excel</div>
                <div style={{ fontSize: 13, color: C.muted, marginBottom: 20 }}>
                  Downloads a formatted <b>.xlsx</b> workbook with four sheets: <em>All Projects</em>, <em>Active Projects</em>,
                  <em> Completed Projects</em>, and <em>Team Capacity</em>.
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 24 }}>
                  {[
                    { label: "All Projects", desc: `${projects.length} rows · 19 columns · status-coloured` },
                    { label: "Active Projects", desc: `${projects.filter(p => p.status !== "Completed").length} rows · timeline & assignee` },
                    { label: "Completed Projects", desc: `${projects.filter(p => p.status === "Completed").length} rows · variance (est vs actual hrs)` },
                    { label: "Team Capacity", desc: `${team.length} members · utilisation %` },
                  ].map(({ label, desc }) => (
                    <div key={label} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "12px 16px" }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: C.navy, marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 12, color: C.muted }}>{desc}</div>
                    </div>
                  ))}
                </div>
                <button
                  disabled={exportLoading}
                  onClick={async () => {
                    setExportLoading(true);
                    try {
                      await exportToExcel({ projects, assignments, owners, team });
                    } finally {
                      setExportLoading(false);
                    }
                  }}
                  style={{
                    padding: "12px 28px", background: exportLoading ? C.muted : C.navy,
                    color: "#fff", border: "none", borderRadius: 8, fontWeight: 700,
                    fontSize: 14, cursor: exportLoading ? "not-allowed" : "pointer",
                  }}
                >
                  {exportLoading ? "Generating…" : "⬇ Download Excel"}
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

      {/* Overload modal */}
      {overloadFlow && (() => {
        const { step, newProjectName, newProjectHrs, targetPerson, theirProjects, pickedProjectId, pickedProjectName, newAssignee } = overloadFlow;
        const overlay = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" };
        const modal = { background: "#fff", borderRadius: 12, padding: 28, maxWidth: 560, width: "90%", boxShadow: "0 8px 40px rgba(0,0,0,0.18)" };

        return (
          <div style={overlay}>
            <div style={modal}>
              {step === "confirm" && (
                <>
                  <div style={{ fontWeight: 700, fontSize: 16, color: "#A32D2D", marginBottom: 8 }}>
                    Overload detected
                  </div>
                  <div style={{ fontSize: 14, color: C.ink, marginBottom: 16 }}>
                    <b>{targetPerson}</b> does not have enough capacity for <b>{newProjectName}</b> ({newProjectHrs} h).
                    Do you want to reassign one of their current projects to free up space?
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      onClick={() => setOverloadFlow(f => ({ ...f, step: "pick-project" }))}
                      style={{ background: C.navy, color: "#fff", border: "none", borderRadius: 6, padding: "8px 20px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                      Accept — reassign a project
                    </button>
                    <button
                      onClick={() => setOverloadFlow(null)}
                      style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 16px", fontSize: 14, cursor: "pointer", color: "#A32D2D", fontWeight: 600 }}>
                      Refuse — assign to someone else
                    </button>
                  </div>
                </>
              )}

              {step === "pick-project" && (
                <>
                  <div style={{ fontWeight: 700, fontSize: 16, color: C.navy, marginBottom: 4 }}>
                    Which project should be reassigned?
                  </div>
                  <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>
                    Select one of <b>{targetPerson}</b>'s active projects to move to someone else.
                  </div>
                  <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
                    {theirProjects.length === 0 ? (
                      <div style={{ color: C.muted, fontSize: 13 }}>No other active projects found for {targetPerson}.</div>
                    ) : theirProjects.map(proj => (
                      <div key={proj.id}
                        onClick={() => setOverloadFlow(f => ({ ...f, pickedProjectId: proj.id, pickedProjectName: proj.name }))}
                        style={{ border: `2px solid ${pickedProjectId === proj.id ? C.navy : C.line}`, borderRadius: 7, padding: "9px 12px", cursor: "pointer", background: pickedProjectId === proj.id ? "#EEF2F8" : "#fff" }}>
                        <div style={{ fontWeight: 600 }}>{proj.id} — {proj.name}</div>
                        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{proj.segment} · {proj.hrs} h est.</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <button
                      disabled={!pickedProjectId}
                      onClick={() => setOverloadFlow(f => ({ ...f, step: "pick-assignee", newAssignee: null }))}
                      style={{ background: pickedProjectId ? C.navy : C.muted, color: "#fff", border: "none", borderRadius: 6, padding: "8px 20px", fontSize: 14, fontWeight: 700, cursor: pickedProjectId ? "pointer" : "not-allowed" }}>
                      Next — choose new assignee
                    </button>
                    <button onClick={() => setOverloadFlow(f => ({ ...f, step: "confirm" }))}
                      style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 14px", fontSize: 13, cursor: "pointer" }}>
                      Back
                    </button>
                  </div>
                </>
              )}

              {step === "pick-assignee" && (() => {
                const pickedProj = projects.find(p => p.id === pickedProjectId);
                const candidates = recommendPeople(pickedProj, team, committedExtra)
                  .filter(r => r.name !== targetPerson);
                return (
                  <>
                    <div style={{ fontWeight: 700, fontSize: 16, color: C.navy, marginBottom: 4 }}>
                      Who should take over <span style={{ color: "#854F0B" }}>{pickedProjectName}</span>?
                    </div>
                    <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>
                      Ownership will transfer to the new assignee. <b>{targetPerson}</b> will then take <b>{newProjectName}</b>.
                    </div>
                    <div style={{ display: "grid", gap: 7, marginBottom: 16 }}>
                      {candidates.length === 0 ? (
                        <div style={{ color: C.muted, fontSize: 13 }}>No eligible candidates found.</div>
                      ) : candidates.map((r, i) => {
                        const selected = newAssignee === r.name;
                        const bc = r.total >= 70 ? "#3B6D11" : r.total >= 45 ? "#854F0B" : "#A32D2D";
                        return (
                          <div key={r.name}
                            onClick={() => setOverloadFlow(f => ({ ...f, newAssignee: r.name }))}
                            style={{ border: `2px solid ${selected ? C.navy : C.line}`, borderRadius: 7, padding: "8px 12px", cursor: "pointer", background: selected ? "#EEF2F8" : "#fff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div>
                              <span style={{ fontWeight: 600 }}>{i + 1}. {r.name}</span>
                              <span style={{ fontSize: 12, color: C.muted, marginLeft: 8 }}>· {r.role}</span>
                              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{r.reasons.join(" · ")}</div>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                              <span style={{ width: 70, height: 6, background: "#eee", borderRadius: 3, overflow: "hidden", display: "inline-block" }}>
                                <span style={{ display: "block", width: r.total + "%", height: "100%", background: bc }} />
                              </span>
                              <b style={{ color: bc, fontSize: 13 }}>{r.total}</b>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <button
                        disabled={!newAssignee}
                        onClick={executeRebalance}
                        style={{ background: newAssignee ? "#3B6D11" : C.muted, color: "#fff", border: "none", borderRadius: 6, padding: "8px 20px", fontSize: 14, fontWeight: 700, cursor: newAssignee ? "pointer" : "not-allowed" }}>
                        Confirm rebalancing
                      </button>
                      <button onClick={() => setOverloadFlow(f => ({ ...f, step: "pick-project", newAssignee: null }))}
                        style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 14px", fontSize: 13, cursor: "pointer" }}>
                        Back
                      </button>
                      <button onClick={() => setOverloadFlow(null)}
                        style={{ background: "none", border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 14px", fontSize: 13, cursor: "pointer", color: "#A32D2D" }}>
                        Cancel
                      </button>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
