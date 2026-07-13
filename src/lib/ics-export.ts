// ====================================================================
// Nexus Gate — .ics (iCalendar) file generator
// --------------------------------------------------------------------
// Generates an .ics file for a single event, compatible with Google
// Calendar, Apple Calendar, Outlook, etc.
// Spec: https://datatracker.ietf.org/doc/html/rfc5545
// ====================================================================

interface IcsEvent {
  title: string;
  description?: string | null;
  scheduledAt: string; // ISO string
  endsAt?: string | null; // ISO string
  location?: string | null;
}

// Format a Date as an iCalendar UTC timestamp: YYYYMMDDTHHMMSSZ
function formatIcsDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

// Escape special characters per RFC 5545 (text values).
function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

// Generate an .ics file content for a single event.
export function generateIcsContent(event: IcsEvent): string {
  const dtStart = formatIcsDate(event.scheduledAt);
  const dtEnd = event.endsAt
    ? formatIcsDate(event.endsAt)
    : formatIcsDate(new Date(new Date(event.scheduledAt).getTime() + 60 * 60 * 1000).toISOString());

  const now = formatIcsDate(new Date().toISOString());
  const uid = `${Date.now()}@nexus-gate`;

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nexus Gate//Attendance System//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];

  if (event.description) {
    lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  }
  if (event.location) {
    lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  }

  lines.push("END:VEVENT", "END:VCALENDAR");

  // RFC 5545 requires CRLF line endings.
  return lines.join("\r\n");
}

// Trigger a browser download of the .ics file.
export function downloadIcsFile(event: IcsEvent): void {
  const content = generateIcsContent(event);
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const safeTitle = event.title.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 50);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeTitle}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Generate an .ics file containing multiple events (bulk export).
export function generateBulkIcsContent(events: IcsEvent[]): string {
  const now = formatIcsDate(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nexus Gate//Attendance System//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const event of events) {
    const dtStart = formatIcsDate(event.scheduledAt);
    const dtEnd = event.endsAt
      ? formatIcsDate(event.endsAt)
      : formatIcsDate(new Date(new Date(event.scheduledAt).getTime() + 60 * 60 * 1000).toISOString());
    const uid = `${Date.now()}-${event.title.length}@nexus-gate`;

    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${escapeIcsText(event.title)}`,
    );
    if (event.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    }
    if (event.location) {
      lines.push(`LOCATION:${escapeIcsText(event.location)}`);
    }
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// Trigger a browser download of a bulk .ics file containing multiple events.
export function downloadBulkIcsFile(events: IcsEvent[], filename = "events.ics"): void {
  const content = generateBulkIcsContent(events);
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
