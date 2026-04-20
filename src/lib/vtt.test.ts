import { describe, expect, it } from "vitest";
import { parseVtt } from "./vtt";

describe("parseVtt", () => {
  it("parses a basic cue", () => {
    const src = `WEBVTT

00:00:01.000 --> 00:00:02.500
Hello world
`;
    const cues = parseVtt(src);
    expect(cues).toEqual([{ start: 1, end: 2.5, text: "Hello world" }]);
  });

  it("parses multiple cues separated by blank lines", () => {
    const src = `WEBVTT

00:00:01.000 --> 00:00:02.000
First

00:00:03.000 --> 00:00:04.500
Second line
`;
    const cues = parseVtt(src);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("First");
    expect(cues[1].text).toBe("Second line");
  });

  it("joins multi-line cue text with newlines", () => {
    const src = `WEBVTT

00:00:01.000 --> 00:00:02.000
Line A
Line B
`;
    const cues = parseVtt(src);
    expect(cues[0].text).toBe("Line A\nLine B");
  });

  it("strips inline tags", () => {
    const src = `WEBVTT

00:00:01.000 --> 00:00:02.000
<c.speaker>Alice:</c> hi
`;
    const cues = parseVtt(src);
    expect(cues[0].text).toBe("Alice: hi");
  });

  it("accepts comma as the millisecond separator", () => {
    const src = `WEBVTT

00:00:01,500 --> 00:00:02,750
ok
`;
    const cues = parseVtt(src);
    expect(cues[0]).toEqual({ start: 1.5, end: 2.75, text: "ok" });
  });

  it("handles CRLF line endings", () => {
    const src = `WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nok\r\n`;
    const cues = parseVtt(src);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("ok");
  });

  it("drops cues with empty text", () => {
    const src = `WEBVTT

00:00:01.000 --> 00:00:02.000

00:00:03.000 --> 00:00:04.000
real
`;
    const cues = parseVtt(src);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("real");
  });
});
