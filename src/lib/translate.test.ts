import { describe, expect, it } from "vitest";
import { __test__ } from "./translate";

const { parseTimeValue, parseLineXml, escapeXml, unescapeXml } = __test__;

describe("parseTimeValue", () => {
  it("parses plain seconds", () => {
    expect(parseTimeValue("12.5")).toBe(12.5);
    expect(parseTimeValue("0")).toBe(0);
    expect(parseTimeValue("600.125")).toBe(600.125);
  });

  it("parses HH:MM:SS clock-time", () => {
    expect(parseTimeValue("00:01:00")).toBe(60);
    expect(parseTimeValue("01:23:45.678")).toBe(3600 + 23 * 60 + 45.678);
  });

  it("returns NaN for garbage", () => {
    expect(parseTimeValue("abc")).toBeNaN();
    expect(parseTimeValue("")).toBeNaN();
  });
});

describe("escapeXml / unescapeXml", () => {
  it("round-trips the XML-dangerous characters", () => {
    const s = `<tag attr="v">he said "hi" & 'bye' <3</tag>`;
    expect(unescapeXml(escapeXml(s))).toBe(s);
  });

  it("does not touch newlines or regular characters", () => {
    const s = "line1\nline2 with 日本語";
    expect(escapeXml(s)).toBe(s);
  });
});

describe("parseLineXml", () => {
  it("parses a well-formed single line", () => {
    const r = parseLineXml(`<line start="10.00" end="12.50">こんにちは</line>`);
    expect(r).toEqual({ start: 10, end: 12.5, text: "こんにちは" });
  });

  it("accepts attributes in any order", () => {
    const r = parseLineXml(`<line end="12.50" start="10.00">hi</line>`);
    expect(r).toEqual({ start: 10, end: 12.5, text: "hi" });
  });

  it("unescapes XML entities inside the text", () => {
    const r = parseLineXml(`<line start="1" end="2">a &amp; b &lt;3</line>`);
    expect(r?.text).toBe("a & b <3");
  });

  it("rejects lines with missing attributes", () => {
    expect(parseLineXml(`<line start="1">text</line>`)).toBeNull();
    expect(parseLineXml(`<line>text</line>`)).toBeNull();
  });

  it("rejects lines with empty text", () => {
    expect(parseLineXml(`<line start="1" end="2"></line>`)).toBeNull();
    expect(parseLineXml(`<line start="1" end="2">   </line>`)).toBeNull();
  });
});
