import ExcelJS from "exceljs";

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
const HEADER_FONT = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
const ACCENT_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6F1FB" } };

function addHeaders(sheet, columns) {
  sheet.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width || 18 }));
  const headerRow = sheet.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.border = { bottom: { style: "thin", color: { argb: "FF2E75B6" } } };
  });
  headerRow.height = 22;
}

function statusColor(status) {
  if (status === "Completed") return "FFD6F0D0";
  if (status === "In Progress") return "FFD6E8FA";
  return "FFF0F0F0";
}

export async function exportToExcel({ projects, assignments, owners, team }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Signify Resource Allocation App";
  wb.created = new Date();

  // ── Sheet 1: All Projects ──────────────────────────────────────
  const s1 = wb.addWorksheet("All Projects");
  addHeaders(s1, [
    { header: "ID",                  key: "id",                    width: 8 },
    { header: "Project Name",        key: "name",                  width: 30 },
    { header: "Segment",             key: "segment",               width: 22 },
    { header: "Phase",               key: "phase",                 width: 16 },
    { header: "Size",                key: "size",                  width: 10 },
    { header: "Complexity",          key: "complexity",            width: 12 },
    { header: "Urgency",             key: "urgency",               width: 26 },
    { header: "Iconic",              key: "iconic",                width: 8 },
    { header: "Repetitive",          key: "repetitive",            width: 11 },
    { header: "Est. Hours",          key: "hrs",                   width: 11 },
    { header: "Actual Hours",        key: "actual_hrs",            width: 12 },
    { header: "Status",              key: "status",                width: 14 },
    { header: "Assigned To",         key: "assignee",              width: 20 },
    { header: "Owner",               key: "owner",                 width: 20 },
    { header: "Tier",                key: "tier",                  width: 8 },
    { header: "Score",               key: "score",                 width: 8 },
    { header: "Assigned Date",       key: "assigned_date",         width: 14 },
    { header: "Expected Delivery",   key: "expected_delivery_date", width: 18 },
    { header: "Actual Delivery",     key: "actual_delivery_date",  width: 16 },
  ]);

  for (const p of projects) {
    const row = s1.addRow({
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
    });
    const fill = { type: "pattern", pattern: "solid", fgColor: { argb: statusColor(p.status) } };
    row.eachCell(cell => { cell.fill = fill; cell.border = { bottom: { style: "hair", color: { argb: "FFD0D0D0" } } }; });
    row.getCell("status").font = { bold: true };
  }
  s1.autoFilter = { from: "A1", to: "S1" };

  // ── Sheet 2: Active Projects ───────────────────────────────────
  const s2 = wb.addWorksheet("Active Projects");
  addHeaders(s2, [
    { header: "ID", key: "id", width: 8 },
    { header: "Project Name", key: "name", width: 30 },
    { header: "Segment", key: "segment", width: 22 },
    { header: "Status", key: "status", width: 14 },
    { header: "Assigned To", key: "assignee", width: 20 },
    { header: "Owner", key: "owner", width: 20 },
    { header: "Est. Hours", key: "hrs", width: 11 },
    { header: "Tier", key: "tier", width: 8 },
    { header: "Assigned Date", key: "assigned_date", width: 14 },
    { header: "Expected Delivery", key: "expected_delivery_date", width: 18 },
  ]);
  for (const p of projects.filter(p => p.status !== "Completed")) {
    const row = s2.addRow({
      id: p.id, name: p.name, segment: p.segment, status: p.status || "Not Started",
      assignee: assignments[p.id] || "", owner: owners[p.id] || "",
      hrs: p.hrs, tier: p.tier ? `Tier ${p.tier}` : "",
      assigned_date: p.assigned_date || "", expected_delivery_date: p.expected_delivery_date || "",
    });
    row.eachCell(cell => { cell.fill = ACCENT_FILL; cell.border = { bottom: { style: "hair", color: { argb: "FFD0D0D0" } } }; });
  }

  // ── Sheet 3: Completed Projects ────────────────────────────────
  const s3 = wb.addWorksheet("Completed Projects");
  addHeaders(s3, [
    { header: "ID", key: "id", width: 8 },
    { header: "Project Name", key: "name", width: 30 },
    { header: "Segment", key: "segment", width: 22 },
    { header: "Assigned To", key: "assignee", width: 20 },
    { header: "Owner", key: "owner", width: 20 },
    { header: "Est. Hours", key: "hrs", width: 11 },
    { header: "Actual Hours", key: "actual_hrs", width: 12 },
    { header: "Variance (h)", key: "variance", width: 13 },
    { header: "Assigned Date", key: "assigned_date", width: 14 },
    { header: "Expected Delivery", key: "expected_delivery_date", width: 18 },
    { header: "Actual Delivery", key: "actual_delivery_date", width: 16 },
  ]);
  for (const p of projects.filter(p => p.status === "Completed")) {
    const variance = (p.actual_hrs || 0) - (p.hrs || 0);
    const row = s3.addRow({
      id: p.id, name: p.name, segment: p.segment,
      assignee: assignments[p.id] || "", owner: owners[p.id] || "",
      hrs: p.hrs, actual_hrs: p.actual_hrs || 0, variance,
      assigned_date: p.assigned_date || "",
      expected_delivery_date: p.expected_delivery_date || "",
      actual_delivery_date: p.actual_delivery_date || "",
    });
    const varCell = row.getCell("variance");
    varCell.font = { bold: true, color: { argb: variance > 0 ? "FFA32D2D" : "FF3B6D11" } };
    row.eachCell(cell => { cell.border = { bottom: { style: "hair", color: { argb: "FFD0D0D0" } } }; });
  }

  // ── Sheet 4: Team Capacity ─────────────────────────────────────
  const s4 = wb.addWorksheet("Team Capacity");
  addHeaders(s4, [
    { header: "Name", key: "name", width: 20 },
    { header: "Role", key: "role", width: 30 },
    { header: "Base Hours/Week", key: "base", width: 16 },
    { header: "Committed Hours", key: "committed", width: 16 },
    { header: "Active Project Hours", key: "project_hrs", width: 20 },
    { header: "Total Committed", key: "total", width: 16 },
    { header: "Available Hours", key: "available", width: 16 },
    { header: "Utilisation %", key: "util", width: 14 },
  ]);
  const projectHrsByPerson = {};
  for (const p of projects) {
    if (p.status === "Completed") continue;
    const who = assignments[p.id];
    if (who) projectHrsByPerson[who] = (projectHrsByPerson[who] || 0) + (p.hrs || 0);
  }
  for (const t of team) {
    const projHrs = projectHrsByPerson[t.name] || 0;
    const total = t.committed + projHrs;
    const available = t.base - total;
    const util = t.base > 0 ? Math.round((total / t.base) * 100) : 0;
    const row = s4.addRow({
      name: t.name, role: t.role, base: t.base, committed: t.committed,
      project_hrs: projHrs, total, available, util: t.base > 0 ? util + "%" : "N/A",
    });
    if (t.base === 0) {
      row.eachCell(cell => { cell.font = { italic: true, color: { argb: "FF999999" } }; });
    } else {
      const utilCell = row.getCell("util");
      utilCell.font = { bold: true, color: { argb: util >= 90 ? "FFA32D2D" : util >= 70 ? "FF854F0B" : "FF3B6D11" } };
    }
    row.eachCell(cell => { cell.border = { bottom: { style: "hair", color: { argb: "FFD0D0D0" } } }; });
  }

  // ── Trigger download ───────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Signify_Resource_Allocation_${new Date().toISOString().split("T")[0]}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}
