# Translation evaluation

How we measure translation quality for the extension, the gold-standard
fixture we measure against, and the session log of prompt iterations so
far.

The extension translates Prime Video English subtitles with Claude.
To tell whether a prompt change actually improves output, we compare it
against Prime Video's own professionally-authored target-language track
for a real episode.

## The harness

Offline scripts under `eval/` (outputs in `eval/out/`, gitignored):

- `eval/translate.mjs <tag>` — parses `/tmp/en.ttml2`, chunks cues (50
  each), calls Claude with the system prompt keyed by `<tag>` (variants
  `v1`..`v4` live inline in the file), saves per-chunk raw output, parsed
  cues, and a token-usage chunk log to `eval/out/<tag>/`.
  v1 matches the production prompt in `src/lib/translate.ts` exactly, so
  `baseline` is a faithful reproduction of what the extension does.
- `eval/diff.mjs <tag>` — pairs our cues to gold `/tmp/ja.ttml2` by
  time-overlap and writes `report.md` with split-structure, style-marker,
  and coverage stats, plus a JSON snapshot.
- `eval/compare.mjs <tag>` — three-way compare `baseline` → `<tag>` →
  gold with ↑/↓/= direction arrows for each metric.

A full 393-cue run takes ~3 minutes and uses roughly 20k input tokens +
12k output tokens (after the system-prompt cache warms up). Cheap enough
to iterate freely.

## Gold fixture: NIPPON SANGOKU S1E1

Captured during the 2026-04-19 debugging session. Intended for offline
translation-quality work — compare Claude output against Prime Video's
official Japanese subtitles.

> ⚠️ TTML URLs are Prime Video edge URLs. They may rotate between sessions
> or become unreachable if the path includes a per-session signing token.
> If a URL 4xx's, re-capture it from DevTools Network with the Prime Video
> player open, English or Japanese subtitles enabled, and filter for
> `cf-timedtext`.

### Title

- **NIPPON SANGOKU: The Three Nations of the Crimson Sun** — S1E1
  "An Oath for Peace"
- Included with Prime (US), anime, 25:45, aired 2026-04-04
- Season detail page: https://www.amazon.com/gp/video/detail/B0FW4TLCJ7
- Episode detail page (playable URL used in debugging):
  https://www.amazon.com/gp/video/detail/0SPTCVEAFL4BJFE4TARP8B1F6K/?autoplay=1&t=0

### Subtitle tracks (TTML2)

Both tracks use the same timebase (median offset between the two across
matched cues is 0 s; 349/393 English cues have a Japanese cue starting
within ±1 s).

**English (source the extension sees)**

```
https://cf-timedtext.aux.pv-cdn.net/6e24/fc8e/4875/4b5c-8065-b5691d1f9ea8/87eda7a8-90a0-4379-8f26-55344e41d165.ttml2
```

- 393 cues, first begin 3.003 s, last end 1473.097 s
- Format: TTML2, clock-time begin/end (`HH:MM:SS.mmm`)
- No `ttp:frameRate` / `ttp:tickRate` — times are seconds

**Japanese (reference / gold standard)**

```
https://cf-timedtext.aux.pv-cdn.net/3d13/e88f/1a30/48d4-9c66-4b1f2306be85/947157e5-4d75-430d-ac9c-6553ccf1be9a.ttml2
```

- 453 cues, first begin 12.763 s, last end ≈1457.665 s
- Drops the two intro disclaimers ("Fictional work…", "Underage smoking…")
- Frequently splits one English cue into 2–3 shorter Japanese cues (1:N)
- Includes narration labels like `（ナレーション）` and ruby hints
  (e.g. `揶揄 やゆ`, `飢饉 ききん`)
- End cue is earlier than English — credits aren't translated

### Playback stream (context)

- DASH manifest + segments from
  `abep5t3aaaaaaaamcwzo5ewrdyqou.vod-dash.main.amazon.pv-cdn.net` /
  `abep5t3aaaaaaaamc3kminj6r3qpe.ta.mid-pop-vod-dash.main.amazon.pv-cdn.net`
- `atv-ps.amazon.com/playback/prs/GetVodPlaybackResources` returns
  `SubtitleUrls` listing all subtitle-language TTML URLs — would be the
  canonical place to detect "official target-language subs exist" at
  runtime.
- `subtitleFormat=TTMLv2` is what the player asks for by default.
- Preroll ad is in a separate `<video>` element; main content is in
  another. Both have `videoWidth > 0`, so content scripts must prefer the
  non-paused element (the fix shipped in `9d4d110`).

### Sample pairs (first 20 English cues → overlapping Japanese)

| i | range (s)   | English                                                                                                   | Official Japanese (time-overlap)                                                              |
|---|-------------|-----------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| 0 | 3.00–5.00   | Fictional work. Any similarity / to real names or events is coincidental.                                  | — (dropped)                                                                                    |
| 1 | 5.09–5.92   | Underage smoking is prohibited.                                                                            | — (dropped)                                                                                    |
| 2 | 12.76–13.93 | End of Reiwa era.                                                                                          | [12.76] （ナレーション）令和末期 / 第４次産業革命において―                                     |
| 3 | 14.01–17.98 | Japan suffered an overwhelming defeat / in the fourth industrial revolution                                | [12.76] …令和末期 / 第４次産業革命において― ‖ [16.06] 日本は米国や中国 / インドなどの諸外国に― |
| 4 | 18.06–21.19 | at the hands of the USA, / China, India and other countries.                                               | [16.06] 日本は米国や中国 / インドなどの諸外国に― ‖ [19.35] 圧倒的大敗を喫した                 |
| 5 | 22.02–25.94 | In addition, the acceleration of the / declining birth rate and aging population                           | [22.02] そして / 加速する少子高齢化― ‖ [24.44] 教育レベルの / 大幅な低下により―                |
| 6 | 26.03–28.99 | and a major drop in education levels / compounded Japan's deterioration.                                   | [24.44] 教育レベルの / 大幅な低下により― ‖ [26.69] 日本は衰退の一途をたどった                 |
| 7 | 30.74–32.62 | A nuclear war broke out.                                                                                   | [30.70] 世界では核大戦が勃発                                                                    |
| 10 | 38.71–41.50 | Furthermore, major earthquakes / hit one after another.                                                   | [38.71] 更には大震災が相次いだ                                                                  |
| 13 | 47.97–52.26 | Suffering government failure, heavy taxes, / natural disasters and famine,                                | [44.96] 上級国民と 揶揄 やゆ される者たちに集中 ‖ [48.09] 悪政 重税 天災― ‖ [50.63] 飢饉 ききん に苦しむ民衆は / ついに 蜂起 ほうき する |
| 15 | 54.22–56.02 | This was The Great Violent Revolution.                                                                    | [54.18] 暴力大革命である                                                                        |
| 20 | 70.86–74.33 | A world of chaotic war / divided by military cliques began.                                               | [70.78] 軍閥が割拠する / 戦乱の世が始まる                                                       |
| 22 | 79.29–82.04 | the three nations of Yamato, Buo and Seii                                                                 | [79.37] 大和 やまと 武凰 ぶおう 聖夷 せいい / 三つの国が覇権を争う―                             |

Full 393-cue comparison table is regenerated every run by
`eval/diff.mjs`.

### Observed style patterns in the official track

Cataloged from the full 393-cue gold track. Useful as a starting point
for prompt iteration — but keep in mind these are JA-anime conventions,
not universal subtitle norms (see "Session log" below for why we don't
hardcode them into a generic prompt):

- **Stage directions in parentheses** for speakers and narration, e.g.
  `（ナレーション）…`, `（三角青輝 みすみあおてる ）…`.
- **Ruby / reading hints** inline with spaces: `揶揄 やゆ `, `蜂起 ほうき `,
  `飢饉 ききん `, `大和 やまと `.
- **Cue splitting at commas / topic shifts** — long English cues become
  2–3 short Japanese cues, each a single breath unit. Gaps are kept
  tight.
- **Mid-sentence continuation dash** `―` on non-final cues of a multi-cue
  sentence.
- **Trailing particles** (e.g. `なって…`) suggest softer tone when the
  source is wistful or hedged.
- **No credits translation** — official track ends before the credits
  cues.
- **Disclaimers dropped** — no Japanese version of "Fictional work…" or
  "Underage smoking is prohibited".

## Session log: 2026-04-19

First full eval pass. Evaluated the shipped prompt, fixed a production
bug, iterated through four prompt variants, landed on v4 (generic).

### What we discovered

**1. Every translation request was failing in production.**
`src/lib/translate.ts` sent `temperature: 0.3` with the API call.
`claude-opus-4-7` rejects this parameter (HTTP 400:
`temperature is deprecated for this model`). The catch block in
`translateCues` falls back to the English source cues per-chunk, so no
error surfaced to the user — they just saw English instead of Japanese.
Every chunk, every call, always. Flagged and fixed before any prompt
work.

**2. The prompt under-skipped on-screen text and disclaimers.**
Gold dropped 17 English cues: intro disclaimers ("Fictional work…"),
all-caps location cards ("EHIME LIBRARY"), character-name title cards
("AOTERU MISUMI / AGE 15"), time-skip captions ("A FEW DAYS LATER"). v1
translated every one of them. These are visual-only chyrons that native
viewers read from the video itself — professional subtitle tracks in
any language omit them.

**3. The prompt produced ASCII punctuation in Japanese output.**
v1 output: `"大暴力革命"` (ASCII `"`), `米中印など、` (ASCII `,`). Gold
uses `「」`, `。`, `、` full-width. The v1 rule "use native punctuation"
was too soft — the model defaulted to Latin forms when uncertain.

**4. The prompt never split long source cues.**
Gold splits 118 of 393 English cues into 2–3 Japanese cues (1:N ratio).
v1 split zero. Even when instructed to, the model preserved the source
1:1 mapping.

**5. Model emits placeholder text when asked to skip.**
When v2 added "skip text cards", the model emitted
`<line>(字幕なし)</line>` ("no subtitle") as a *Japanese translation* of
the disclaimer rather than omitting the cue entirely. Required an
explicit "emit zero `<line>` tags" rule in v3/v4.

**6. Model typos can corrupt parsing.**
Once across a 393-cue run, v4 emitted `</link>` instead of `</line>`,
which the current regex in `src/lib/translate.ts` didn't match. The
following cue was absorbed into the previous cue's content.

### What we fixed

**Bug fix: removed deprecated `temperature`.**
`src/lib/translate.ts` no longer sends `temperature`. Every API call now
goes through instead of silently 400-ing.

**New prompt: v4 (generic, language-neutral).**
Replaces v1 in `src/lib/translate.ts`. Design principle: ship rules that
generalize across target languages, delegate language-specific
conventions to the model's own knowledge.

Universal rules baked in:

- Skip on-screen text cards and legal disclaimers (emit zero `<line>`
  tags).
- Splitting long or clause-spanning source cues into 2–3 shorter cues is
  expected, not optional — gated by concrete triggers (comma, line
  break, connector, too-long rendering).
- Use the target language's native punctuation conventions.
- Silent skip — no placeholder, no empty tag, no "(no subtitle)" text.

Deliberately generic (delegated to the model):

- Cross-cue continuation marker (em-dash in JA, ellipsis elsewhere,
  nothing in many languages).
- Narration label (JA `（ナレーション）`, EN `(NARRATOR)`).
- Annotation for unfamiliar proper nouns (ruby/furigana,
  transliteration, italics).

**Measured impact against gold:**

| metric | v1 (was shipped) | **v4 (now shipped)** | gold |
|---|---|---|---|
| Disclaimer / text-card skip | 3 | **20** | 17 |
| ASCII chars in JA output | 35 | **≈0** *(16 from one model typo)* | 0 |
| Ruby hints | 9 | **10** | 10 |
| JA quotes `「」` used | never | **yes** | yes |
| Placeholder-text bug | — | **fixed** | — |
| Splitting 1→N cues | 0 | 2 | 118 |

v4's content quality also looks noticeably more natural than v1 on
side-by-side comparison of the first 30 cues — see
`eval/out/v4/compare.md` for the full table.

### What we did NOT fix

**Cue splitting (118 gold splits → v4's 2).**
The gold's 1:N cue-splitting reflects Japanese *audio* rhythm — gold
often creates cue boundaries where there's a pause in the voice-over but
no boundary in the English timestamps we see. Without audio access, the
model can only create boundaries at signals present in the English source
(line breaks `/`, commas). That gave v2 six splits; v3's mandatory-split
rule plus few-shot gave eight — nowhere near 118. Generic v4 is back at
two. This gap appears structural to the input, not addressable through
prompt tuning alone.

*Revisit if:* we add audio transcription as an input signal, or switch
to a two-pass prompt (first pass: English → intermediate Japanese;
second pass: re-chunk based on Japanese reading rhythm).

**Parser fragility to typo'd close tags.**
`src/lib/translate.ts` uses a literal `</line>` close in its regex. When
the model typos the close tag (`</link>`, `</ine>`, etc.) the cue
swallows the next cue's opening and both are lost. Only saw this once
in the eval run, so impact is low, but a defensive parser that
tolerates close-tag typos would make the extension more robust.

**Proper-noun glossary.**
Gold's `武凰 ぶおう`, `聖夷 せいい` specific kanji choices aren't
guessable from English ("Buo", "Seii") without a show-specific glossary.
The model's transliterations are reasonable but consistently wrong. Out
of scope for prompt tuning; would need a per-show glossary mechanism
(user-provided, or scraped from MyAnimeList / Wikipedia per title).

**Narration labels landed only a handful of times.**
v4 emits `（ナレーション）` twice; gold has it wherever a narrator
speaks (many times across the episode). Without knowing who is talking,
the model can only infer "this is narration" for the most obvious
opening exposition. Harder cases (mid-episode voice-over flashbacks) get
missed. Probably needs either audio or a speaker-diarization pre-pass.

## Reproducing the comparison manually

From a DevTools console on any page (no auth needed — the URLs above are
bare paths):

```js
const engUrl = '<english ttml url>';
const jaUrl  = '<japanese ttml url>';
const [engT, jaT] = await Promise.all([
  fetch(engUrl, { credentials: 'omit' }).then(r => r.text()),
  fetch(jaUrl,  { credentials: 'omit' }).then(r => r.text()),
]);
const pt = s => { const m = s.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/); return m ? +m[1]*3600 + +m[2]*60 + +m[3] : +s; };
const parseCues = text => [...text.matchAll(/<p\s+[^>]*begin="([^"]+)"[^>]*end="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g)]
  .map(m => ({ start: pt(m[1]), end: pt(m[2]), text: m[3].replace(/<br\s*\/?>/gi, ' / ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() }));
const eng = parseCues(engT);
const ja  = parseCues(jaT);
const pairs = eng.map((e, i) => ({
  i, eng: e.text, start: e.start, end: e.end,
  jaOfficial: ja.filter(j => j.start < e.end && j.end > e.start).map(j => `[${j.start.toFixed(2)}] ${j.text}`).join(' || '),
}));
console.table(pairs.slice(0, 30));
```

## Session debugging anchor points

- Content-script host IDs in the page DOM: `#jimaku-button-host`,
  `#jimaku-host` (each with shadow DOM).
- Prime Video's rendered caption element (for side-by-side sanity
  checks): `.atvwebplayersdk-captions-text`.
- Chrome launched via `npm run chrome` (DevTools port 9222), profile at
  `.chrome-profile/` — `extensions.ui.developer_mode` must be `true` in
  `Default/Preferences` or `--load-extension` is silently dropped.
- Extension ID last seen: `baopcgppgpkignebdkgfhfhmdmoiccei` (unpacked
  from `dist/`; can change if the dir is repacked).
