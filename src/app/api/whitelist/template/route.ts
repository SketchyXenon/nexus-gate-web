import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api";

// ====================================================================
// GET /api/whitelist/template (ORGANIZER+)
// --------------------------------------------------------------------
// Downloads an Excel template (.xlsx) with the correct column headers
// and sample rows, so admins/organizers know the expected format.
// Uses exceljs instead of xlsx (which had a prototype pollution CVE).
// ====================================================================
export async function GET(_req: NextRequest) {
  const res = await requireAuth("ORGANIZER");
  if ("error" in res) return res.error;

  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Students");

  // Define columns with widths.
  sheet.columns = [
    { header: "studentId", key: "studentId", width: 12 },
    { header: "email", key: "email", width: 28 },
    { header: "fullName", key: "fullName", width: 22 },
    { header: "program", key: "program", width: 10 },
    { header: "section", key: "section", width: 10 },
  ];

  // Add sample rows.
  sheet.addRows([
    {
      studentId: 3240001,
      email: "jane.doe@ctu.edu.ph",
      fullName: "Jane Dela Cruz",
      program: "BSIT",
      section: "2-B",
    },
    {
      studentId: 3240002,
      email: "john.smith@ctu.edu.ph",
      fullName: "John Smith",
      program: "BSMx",
      section: "1-A",
    },
    {
      studentId: 3240003,
      email: "maria.garcia@ctu.edu.ph",
      fullName: "Maria Garcia",
      program: "BIT-CT",
      section: "3-C",
    },
  ]);

  // Bold the header row.
  sheet.getRow(1).font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();

  return new NextResponse(Buffer.from(buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition":
        'attachment; filename="nexus-gate-student-template.xlsx"',
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
