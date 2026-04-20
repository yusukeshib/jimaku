import { describe, expect, it } from "vitest";
import { parseTtml } from "./ttml";

const wrap = (body: string, head = "") =>
  `<?xml version="1.0" encoding="utf-8"?>
<tt xmlns="http://www.w3.org/ns/ttml"
    xmlns:tts="http://www.w3.org/ns/ttml#styling"
    xmlns:ttp="http://www.w3.org/ns/ttml#parameter"
    ttp:version="2"${head}>
  <body><div>${body}</div></body>
</tt>`;

describe("parseTtml", () => {
  it("parses basic clock-time cues", () => {
    const src = wrap(`
      <p begin="00:00:01.000" end="00:00:02.500">Hello</p>
      <p begin="00:00:03.100" end="00:00:04.200">World</p>
    `);
    const cues = parseTtml(src);
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: "Hello" },
      { start: 3.1, end: 4.2, text: "World" },
    ]);
  });

  it("converts <br/> inside a cue to a newline", () => {
    const src = wrap(`<p begin="00:00:01" end="00:00:02">Line A<br/>Line B</p>`);
    expect(parseTtml(src)[0].text).toBe("Line A\nLine B");
  });

  it("unwraps <span> without losing text", () => {
    const src = wrap(
      `<p begin="00:00:01" end="00:00:02"><span style="s0">italic</span> and plain</p>`,
    );
    expect(parseTtml(src)[0].text).toBe("italic and plain");
  });

  it("parses offset-time values with s/m/h suffixes", () => {
    const src = wrap(`
      <p begin="1.5s" end="2.5s">a</p>
      <p begin="1m" end="61s">b</p>
    `);
    const cues = parseTtml(src);
    expect(cues[0]).toMatchObject({ start: 1.5, end: 2.5 });
    expect(cues[1]).toMatchObject({ start: 60, end: 61 });
  });

  it("parses tick-based times using ttp:tickRate", () => {
    const src = wrap(
      `<p begin="10000000t" end="20000000t">tick</p>`,
      ` ttp:tickRate="10000000"`,
    );
    const cues = parseTtml(src);
    expect(cues[0]).toEqual({ start: 1, end: 2, text: "tick" });
  });

  it("skips paragraphs with missing/invalid times", () => {
    const src = wrap(`
      <p begin="00:00:01" end="00:00:02">kept</p>
      <p>no attrs</p>
      <p begin="bogus" end="00:00:04">bad start</p>
    `);
    const cues = parseTtml(src);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("kept");
  });

  it("collapses runs of whitespace inside a paragraph", () => {
    const src = wrap(
      `<p begin="00:00:01" end="00:00:02">  hello   world  </p>`,
    );
    expect(parseTtml(src)[0].text).toBe("hello world");
  });
});
