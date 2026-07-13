import { describe, it, expect } from "vitest";
import { generateIcsContent, generateBulkIcsContent } from "./ics-export";

describe("ics-export", () => {
  describe("generateIcsContent", () => {
    it("generates a valid .ics structure for a simple event", () => {
      const content = generateIcsContent({
        title: "Math 101",
        scheduledAt: "2026-07-15T09:00:00.000Z",
        endsAt: "2026-07-15T10:00:00.000Z",
      });

      // Must start and end with the VCALENDAR block.
      expect(content.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
      expect(content).toContain("END:VCALENDAR");

      // Must contain VERSION and PRODID.
      expect(content).toContain("VERSION:2.0");
      expect(content).toContain("PRODID:-//Nexus Gate//Attendance System//EN");

      // Must contain a VEVENT block.
      expect(content).toContain("BEGIN:VEVENT");
      expect(content).toContain("END:VEVENT");

      // Must contain the title.
      expect(content).toContain("SUMMARY:Math 101");
    });

    it("formats DTSTART and DTEND as UTC iCalendar timestamps", () => {
      const content = generateIcsContent({
        title: "Test",
        scheduledAt: "2026-07-15T09:00:00.000Z",
        endsAt: "2026-07-15T10:30:00.000Z",
      });

      expect(content).toContain("DTSTART:20260715T090000Z");
      expect(content).toContain("DTEND:20260715T103000Z");
    });

    it("defaults DTEND to 1 hour after DTSTART when endsAt is not provided", () => {
      const content = generateIcsContent({
        title: "No end time",
        scheduledAt: "2026-07-15T14:00:00.000Z",
      });

      expect(content).toContain("DTSTART:20260715T140000Z");
      expect(content).toContain("DTEND:20260715T150000Z");
    });

    it("includes DESCRIPTION when provided", () => {
      const content = generateIcsContent({
        title: "Event with description",
        description: "Bring your textbooks",
        scheduledAt: "2026-07-15T09:00:00.000Z",
      });

      expect(content).toContain("DESCRIPTION:Bring your textbooks");
    });

    it("escapes special characters in text fields", () => {
      const content = generateIcsContent({
        title: "Event: Part 1, Part 2; Done",
        description: "Line one\nLine two",
        scheduledAt: "2026-07-15T09:00:00.000Z",
      });

      // Commas, semicolons, and colons in text values must be escaped.
      // (Colons in SUMMARY are technically allowed since the first colon
      // is the property delimiter, but we escape commas and semicolons.)
      expect(content).toContain("SUMMARY:Event: Part 1\\, Part 2\\; Done");
      expect(content).toContain("DESCRIPTION:Line one\\nLine two");
    });

    it("uses CRLF line endings per RFC 5545", () => {
      const content = generateIcsContent({
        title: "CRLF test",
        scheduledAt: "2026-07-15T09:00:00.000Z",
      });

      // Every line break must be CRLF (no bare LF).
      expect(content).toContain("\r\n");
      expect(content).not.toMatch(/[^\r]\n/);
    });

    it("includes a unique UID", () => {
      const content = generateIcsContent({
        title: "UID test",
        scheduledAt: "2026-07-15T09:00:00.000Z",
      });

      expect(content).toMatch(/UID:\d+@nexus-gate/);
    });

    it("includes a DTSTAMP (creation timestamp)", () => {
      const content = generateIcsContent({
        title: "DTSTAMP test",
        scheduledAt: "2026-07-15T09:00:00.000Z",
      });

      expect(content).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
    });

    it("includes LOCATION when provided", () => {
      const content = generateIcsContent({
        title: "Location test",
        scheduledAt: "2026-07-15T09:00:00.000Z",
        location: "Room 204",
      });

      expect(content).toContain("LOCATION:Room 204");
    });
  });
});

describe("generateBulkIcsContent", () => {
  it("generates a valid .ics with multiple VEVENT blocks", () => {
    const content = generateBulkIcsContent([
      { title: "Event A", scheduledAt: "2026-07-15T09:00:00.000Z", endsAt: "2026-07-15T10:00:00.000Z" },
      { title: "Event B", scheduledAt: "2026-07-16T14:00:00.000Z", endsAt: "2026-07-16T15:00:00.000Z" },
    ]);

    expect(content.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(content).toContain("END:VCALENDAR");
    expect(content).toContain("SUMMARY:Event A");
    expect(content).toContain("SUMMARY:Event B");
    // Two VEVENT blocks.
    const veventCount = (content.match(/BEGIN:VEVENT/g) || []).length;
    expect(veventCount).toBe(2);
  });

  it("handles an empty events array (just the VCALENDAR wrapper)", () => {
    const content = generateBulkIcsContent([]);
    expect(content).toContain("BEGIN:VCALENDAR");
    expect(content).toContain("END:VCALENDAR");
    const veventCount = (content.match(/BEGIN:VEVENT/g) || []).length;
    expect(veventCount).toBe(0);
  });

  it("uses CRLF line endings for bulk export", () => {
    const content = generateBulkIcsContent([
      { title: "Test", scheduledAt: "2026-07-15T09:00:00.000Z" },
    ]);
    expect(content).toContain("\r\n");
    expect(content).not.toMatch(/[^\r]\n/);
  });
});
