import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";
import * as XLSX from "xlsx";

// ====================================================================
// GET /api/whitelist/template (ORGANIZER+)
// --------------------------------------------------------------------
// Downloads an Excel template (.xlsx) with the correct column headers
// and a sample row, so admins/organizers know the expected format.
// ====================================================================
export async function GET(_req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;

  // Create worksheet with headers + sample row
  const data = [
    ["studentId", "email", "fullName", "program", "section"],
    [3240001, "jane.doe@ctu.edu.ph", "Jane Dela Cruz", "BSIT", "2-B"],
    [3240002, "john.smith@ctu.edu.ph", "John Smith", "BSMx", "1-A"],
    [3240003, "maria.garcia@ctu.edu.ph", "Maria Garcia", "BIT-CT", "3-C"],
  ];

  const ws = XLSX.utils.aoa_to_sheet(data);

  // Set column widths
  ws["!cols"] = [
    { wch: 12 }, // studentId
    { wch: 28 }, // email
    { wch: 22 }, // fullName
    { wch: 10 }, // program
    { wch: 10 }, // section
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Students");

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="nexus-gate-student-template.xlsx"',
    },
  });
}
