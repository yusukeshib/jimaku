import { describe, expect, it } from "vitest";
import { CueList, normalizeCueText, SourceCueIndex } from "./cueList";

describe("normalizeCueText", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeCueText("Hello, World!")).toBe("hello world");
  });

  it("collapses whitespace", () => {
    expect(normalizeCueText("  foo\n\tbar  ")).toBe("foo bar");
  });

  it("keeps non-Latin letters", () => {
    expect(normalizeCueText("こんにちは 世界")).toBe("こんにちは 世界");
  });

  it("returns empty string for punctuation-only input", () => {
    expect(normalizeCueText("!!!???")).toBe("");
    expect(normalizeCueText("   ")).toBe("");
  });
});

describe("CueList", () => {
  const cue = (start: number, end: number, text: string) => ({ start, end, text });

  describe("set", () => {
    it("sorts cues by start", () => {
      const list = new CueList();
      list.set([cue(5, 6, "b"), cue(1, 2, "a"), cue(3, 4, "middle")]);
      expect(list.snapshot().map((c) => c.text)).toEqual(["a", "middle", "b"]);
    });

    it("replaces the previous contents", () => {
      const list = new CueList();
      list.set([cue(1, 2, "first")]);
      list.set([cue(10, 11, "second")]);
      expect(list.size).toBe(1);
      expect(list.snapshot()[0].text).toBe("second");
    });
  });

  describe("append", () => {
    it("appends chronologically (common case is O(1) tail)", () => {
      const list = new CueList();
      list.append(cue(1, 2, "a"));
      list.append(cue(3, 4, "b"));
      list.append(cue(5, 6, "c"));
      expect(list.snapshot().map((c) => c.text)).toEqual(["a", "b", "c"]);
    });

    it("inserts out-of-order cues in the right slot", () => {
      const list = new CueList();
      list.append(cue(1, 2, "a"));
      list.append(cue(5, 6, "c"));
      list.append(cue(3, 4, "b"));
      expect(list.snapshot().map((c) => c.text)).toEqual(["a", "b", "c"]);
    });
  });

  describe("findAt", () => {
    const build = () => {
      const list = new CueList();
      list.set([cue(10, 12, "a"), cue(13, 15, "b"), cue(20, 22, "c")]);
      return list;
    };

    it("returns the active cue at an exact start", () => {
      expect(build().findAt(10)?.text).toBe("a");
      expect(build().findAt(13)?.text).toBe("b");
    });

    it("returns the active cue at a time within a cue range", () => {
      expect(build().findAt(11)?.text).toBe("a");
      expect(build().findAt(14.5)?.text).toBe("b");
    });

    it("returns null in a gap between cues", () => {
      expect(build().findAt(12.5)).toBeNull();
      expect(build().findAt(16)).toBeNull();
    });

    it("returns null before the first cue", () => {
      expect(build().findAt(0)).toBeNull();
      expect(build().findAt(9.99)).toBeNull();
    });

    it("returns null after the last cue", () => {
      expect(build().findAt(100)).toBeNull();
    });

    it("returns null for an empty list", () => {
      expect(new CueList().findAt(5)).toBeNull();
    });
  });

  describe("clear", () => {
    it("empties the list", () => {
      const list = new CueList();
      list.set([cue(1, 2, "a")]);
      list.clear();
      expect(list.size).toBe(0);
      expect(list.findAt(1)).toBeNull();
    });
  });
});

describe("SourceCueIndex", () => {
  const cue = (text: string) => ({ start: 0, end: 1, text });

  it("indexes cues by normalized text", () => {
    const idx = new SourceCueIndex();
    idx.set([cue("Hello, World!")]);
    expect(idx.lookupByText("hello world")).toHaveLength(1);
  });

  it("returns undefined for unknown text", () => {
    const idx = new SourceCueIndex();
    idx.set([cue("hello")]);
    expect(idx.lookupByText("missing")).toBeUndefined();
  });

  it("groups multiple cues with the same normalized text", () => {
    const idx = new SourceCueIndex();
    idx.set([cue("Yes."), cue("yes!"), cue("YES")]);
    expect(idx.lookupByText("yes")).toHaveLength(3);
  });

  it("skips cues whose normalized text is empty", () => {
    const idx = new SourceCueIndex();
    idx.set([cue("..."), cue("real")]);
    expect(idx.lookupByText("")).toBeUndefined();
    expect(idx.lookupByText("real")).toHaveLength(1);
  });

  it("clear drops all indexed cues", () => {
    const idx = new SourceCueIndex();
    idx.set([cue("a"), cue("b")]);
    idx.clear();
    expect(idx.size).toBe(0);
    expect(idx.lookupByText("a")).toBeUndefined();
  });
});
