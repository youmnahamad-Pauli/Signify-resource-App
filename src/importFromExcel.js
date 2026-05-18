import * as XLSX from "xlsx";

const HEADER_MAP = {
  "Project Name":      { key: "name" },
  "Segment":           { key: "segment" },
  "Phase":             { key: "phase" },
  "Size":              { key: "size" },
  "Complexity":        { key: "complexity" },
  "Urgency":           { key: "urgency" },
  "Iconic":            { key: "iconic",     bool: true },
  "Repetitive":        { key: "repetitive", bool: true },
  "Est. Hours":        { key: "hrs",        num: true },
  "Actual Hours":      { key: "actual_hrs", num: true },
  "Status":            { key: "status" },
  "Assigned Date":     { key: "assigned_date" },
  "Expected Delivery": { key: "expected_delivery_date" },
  "Actual Delivery":   { key: "actual_delivery_date" },
};

export function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
        const sheetName = wb.SheetNames.includes("All Projects")
          ? "All Projects"
          : wb.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });

        const projects = rows
          .map(row => {
            const p = {};
            for (const [col, def] of Object.entries(HEADER_MAP)) {
              const val = row[col];
              if (def.bool)  p[def.key] = val === "Yes" || val === true;
              else if (def.num) p[def.key] = Number(val) || 0;
              else p[def.key] = String(val || "").trim();
            }
            return p;
          })
          .filter(p => p.name);

        resolve(projects);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
