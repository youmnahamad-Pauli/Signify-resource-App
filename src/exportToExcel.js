import * as XLSX from "xlsx";

function makeSheet(rows, headers) {
  const data = [headers.map(h => h.label), ...rows.map(r => headers.map(h => r[h.key] ?? ""))];
  return XLSX.utils.aoa_to_sheet(data);
}

function statusColor(status) {
  if (status === "Completed") return "D6F0D0";
  if (status === "In Progress") return "D6E8FA";
  return "F0F0F0";
}

export async function exportToExcel({ projects, assignments, owners, team }) {
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: "Signify Resource Allocation", CreatedDate: new Date() };

  // ── Sheet 1: All Projects ──────────────────────────────────────
  const allHeaders = [
    { label: "ID",                key: "id" },
    { label: "Project Name",      key: "name" },
    { label: "Segment",           key: "segment" },
    { label: "Phase",             key: "phase" },
    { label: "Size",              key: "size" },
    { label: "Complexity",        key: "complexity" },
    { label: "Urgency",           key: "urgency" },
    { label: "Iconic",            key: "iconic" },
    { label: "Repetitive",        key: "repetitive" },
    { label: "Est. Hours",        key: "hrs" },
    { label: "Actual Hours",      key: "actual_hrs" },
    { label: "Status",            key: "status" },
    { label: "Assigned To",       key: "assignee" },
    { label: "Owner",             key: "owner" },
    { label: "Tier",              key: "tier" },
    { label: "Score",             key: "score" },
    { label: "Assigned Date",     key: "assigned_date" },
    { label: "Expected Delivery", key: "expected_delivery_date" },
    { label: "Actual Delivery",   key: "actual_delivery_date" },
  ];

  const allRows = projects.map(p => ({
    id: p.id,
    name: p.name,
    segment: p.segment,
    phase: p.phase,
    size: p.size,
    complexity: p.complexity,
    urgency: p.urgency,
    iconic: p.iconic ? "Yes" : "No",
    repetitive: p.repetitive ? "Yes" : "No",
    hrs: p.hrs,
    actual_hrs: p.actual_hrs || "",
    status: p.status || "Not Started",
    assignee: assignments[p.id] || "",
    owner: owners[p.id] || "",
    tier: p.tier ? `Tier ${p.tier}` : "",
    score: p.raw || "",
    assigned_date: p.assigned_date || "",
    expected_delivery_date: p.expected_delivery_date || "",
    actual_delivery_date: p.actual_delivery_date || "",
  }));

  const s1 = makeSheet(allRows, allHeaders);
  s1["!cols"] = [8,30,22,16,10,12,26,8,11,11,12,14,20,20,8,8,14,18,16].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, s1, "All Projects");

  // ── Sheet 2: Active Projects ───────────────────────────────────
  const activeHeaders = [
    { label: "ID",                key: "id" },
    { label: "Project Name",      key: "name" },
    { label: "Segment",           key: "segment" },
    { label: "Status",            key: "status" },
    { label: "Assigned To",       key: "assignee" },
    { label: "Owner",             key: "owner" },
    { label: "Est. Hours",        key: "hrs" },
    { label: "Tier",              key: "tier" },
    { label: "Assigned Date",     key: "assigned_date" },
    { label: "Expected Delivery", key: "expected_delivery_date" },
  ];

  const activeRows = projects
    .filter(p => p.status !== "Completed")
    .map(p => ({
      id: p.id, name: p.name, segment: p.segment,
      status: p.status || "Not Started",
      assignee: assignments[p.id] || "", owner: owners[p.id] || "",
      hrs: p.hrs, tier: p.tier ? `Tier ${p.tier}` : "",
      assigned_date: p.assigned_date || "",
      expected_delivery_date: p.expected_delivery_date || "",
    }));

  const s2 = makeSheet(activeRows, activeHeaders);
  s2["!cols"] = [8,30,22,14,20,20,11,8,14,18].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, s2, "Active Projects");

  // ── Sheet 3: Completed Projects ────────────────────────────────
  const completedHeaders = [
    { label: "ID",                key: "id" },
    { label: "Project Name",      key: "name" },
    { label: "Segment",           key: "segment" },
    { label: "Assigned To",       key: "assignee" },
    { label: "Owner",             key: "owner" },
    { label: "Est. Hours",        key: "hrs" },
    { label: "Actual Hours",      key: "actual_hrs" },
    { label: "Variance (h)",      key: "variance" },
    { label: "Assigned Date",     key: "assigned_date" },
    { label: "Expected Delivery", key: "expected_delivery_date" },
    { label: "Actual Delivery",   key: "actual_delivery_date" },
  ];

  const completedRows = projects
    .filter(p => p.status === "Completed")
    .map(p => ({
      id: p.id, name: p.name, segment: p.segment,
      assignee: assignments[p.id] || "", owner: owners[p.id] || "",
      hrs: p.hrs, actual_hrs: p.actual_hrs || 0,
      variance: (p.actual_hrs || 0) - (p.hrs || 0),
      assigned_date: p.assigned_date || "",
      expected_delivery_date: p.expected_delivery_date || "",
      actual_delivery_date: p.actual_delivery_date || "",
    }));

  const s3 = makeSheet(completedRows, completedHeaders);
  s3["!cols"] = [8,30,22,20,20,11,12,13,14,18,16].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, s3, "Completed Projects");

  // ── Sheet 4: Team Capacity ─────────────────────────────────────
  const teamHeaders = [
    { label: "Name",                 key: "name" },
    { label: "Role",                 key: "role" },
    { label: "Base Hours/Week",      key: "base" },
    { label: "Committed Hours",      key: "committed" },
    { label: "Active Project Hours", key: "project_hrs" },
    { label: "Total Committed",      key: "total" },
    { label: "Available Hours",      key: "available" },
    { label: "Utilisation %",        key: "util" },
  ];

  const projectHrsByPerson = {};
  for (const p of projects) {
    if (p.status === "Completed") continue;
    const who = assignments[p.id];
    if (who) projectHrsByPerson[who] = (projectHrsByPerson[who] || 0) + (p.hrs || 0);
  }

  const teamRows = team.map(t => {
    const projHrs = projectHrsByPerson[t.name] || 0;
    const total = t.committed + projHrs;
    const available = t.base - total;
    const util = t.base > 0 ? Math.round((total / t.base) * 100) : 0;
    return {
      name: t.name, role: t.role, base: t.base,
      committed: t.committed, project_hrs: projHrs,
      total, available, util: t.base > 0 ? util + "%" : "N/A",
    };
  });

  const s4 = makeSheet(teamRows, teamHeaders);
  s4["!cols"] = [20,30,16,16,20,16,16,14].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, s4, "Team Capacity");

  // ── Trigger download ───────────────────────────────────────────
  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Signify_Resource_Allocation_${new Date().toISOString().split("T")[0]}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
