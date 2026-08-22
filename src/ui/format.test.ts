import { describe, it, expect } from "vitest";
import { fmtSimClock, fmtSession, fmtInt, fmtAge, escapeHtml, fmtTimestamp, fmtClockAmPm } from "./format";

describe("fmtSimClock", () => {
  it("pads to a 24-hour wall clock", () => {
    expect(fmtSimClock(0)).toBe("00:00");
    expect(fmtSimClock(8 * 60 + 12)).toBe("08:12");
    expect(fmtSimClock(23 * 60 + 59)).toBe("23:59");
  });

  it("wraps past midnight instead of reading 24:00", () => {
    // The sim clock runs on for days; it must not print a 25th hour.
    expect(fmtSimClock(24 * 60)).toBe("00:00");
    expect(fmtSimClock(25 * 60 + 30)).toBe("01:30");
  });

  it("truncates a fractional minute rather than rounding into the next", () => {
    expect(fmtSimClock(59.9)).toBe("00:59");
  });
});

describe("fmtSession", () => {
  it("drops the hour field under an hour", () => {
    expect(fmtSession(0)).toBe("0MIN");
    expect(fmtSession(59)).toBe("0MIN");
    expect(fmtSession(90 * 60)).toBe("1HR 30MIN");
  });

  it("pads the minutes so the column stays aligned", () => {
    expect(fmtSession(3600 + 5 * 60)).toBe("1HR 05MIN");
  });

  it("keeps counting past a day rather than wrapping", () => {
    expect(fmtSession(26 * 3600)).toBe("26HR 00MIN");
  });
});

describe("fmtInt", () => {
  it("groups thousands", () => {
    expect(fmtInt(5093)).toBe("5,093");
    expect(fmtInt(264000)).toBe("264,000");
  });

  it("rounds rather than truncating", () => {
    expect(fmtInt(0.6)).toBe("1");
    expect(fmtInt(-0.6)).toBe("-1");
  });
});

describe("fmtAge", () => {
  it("stays in seconds under a minute", () => {
    expect(fmtAge(0)).toBe("0S");
    expect(fmtAge(59)).toBe("59S");
  });

  it("switches to minutes, then hours", () => {
    expect(fmtAge(60)).toBe("1M");
    expect(fmtAge(59 * 60)).toBe("59M");
    expect(fmtAge(3600)).toBe("1H");
    expect(fmtAge(5 * 3600)).toBe("5H");
  });

  it("clamps a negative age to zero rather than printing one", () => {
    // Clock skew between the viewer and the publisher can make a fix look
    // like it arrives from the future.
    expect(fmtAge(-30)).toBe("0S");
  });
});

describe("escapeHtml", () => {
  it("neutralises every character that could open a tag or attribute", () => {
    expect(escapeHtml(`<script>`)).toBe("&lt;script&gt;");
    expect(escapeHtml(`a"b'c&d`)).toBe("a&quot;b&#39;c&amp;d");
  });

  it("escapes the ampersand of an entity too, so nothing double-decodes", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves the accented and apostrophed names this city is full of readable", () => {
    expect(escapeHtml("Kralingse Zoom")).toBe("Kralingse Zoom");
    expect(escapeHtml("'s-Gravendijkwal")).toBe("&#39;s-Gravendijkwal");
  });

  it("survives values that are not strings", () => {
    expect(escapeHtml(null as unknown as string)).toBe("null");
    expect(escapeHtml(42 as unknown as string)).toBe("42");
  });
});

describe("clock formatting", () => {
  const at = new Date("2026-08-21T06:07:08Z"); // 08:07:08 in Rotterdam (CEST)

  it("renders the log timestamp in Rotterdam's 24-hour time", () => {
    expect(fmtTimestamp(at, "Europe/Amsterdam")).toBe("08:07:08");
  });

  it("renders the header clock as compact 12-hour time", () => {
    expect(fmtClockAmPm(at, "Europe/Amsterdam")).toBe("8:07AM");
  });

  it("follows the zone it is given, not the machine's", () => {
    expect(fmtTimestamp(at, "UTC")).toBe("06:07:08");
  });
});
