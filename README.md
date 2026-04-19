# Prime JA Subs

Amazon Prime Video の英語字幕を Claude Opus 4.7 で日本語に翻訳し、動画上にオーバーレイ表示する Chrome 拡張（MV3）。

## 開発

```bash
npm install
npm run dev      # Vite dev build
npm run build    # 本番ビルド -> dist/
npm run lint     # Biome でチェック
npm run format   # Biome でフォーマット
npm run typecheck
```

## インストール（未署名）

1. `npm run build`
2. Chrome → `chrome://extensions` → デベロッパーモード ON
3. 「パッケージ化されていない拡張機能を読み込む」→ `dist/` を選択
4. 拡張機能のオプションから Anthropic API キーを入力

## 既知の制約

### 字幕 URL の自動検出は完全ではない
`webRequest` で `.vtt` / `.dfxp` / `.ttml` 拡張子、および `caption` / `subtitle` / `timedtext` / `subtitleset` を含む `.xml` / `.json` を検出している。Prime が返す実際の URL パターンは作品や配信経路で変わるため、**検出漏れ (false negative) が発生しうる**。実機で見つけたパターンがあれば `src/background.ts` の `SUBTITLE_URL_RE` / `SUBTITLE_PATH_HINT` に追加する。

### HLS / m3u8 字幕トラックは未対応
最近の Prime Video は WebVTT を `.m3u8` プレイリスト内のセグメントに分割して配信する作品がある。この場合プレイリストをパースしてセグメントを結合するレイヤーが必要だが MVP では未実装。今後のフェーズで対応予定。

### その他
- 翻訳は `<line>` タグ形式で Claude から取得。モデルがタグを壊した場合はそのチャンクが英語フォールバックになる（リトライ 4 回 + 指数バックオフで緩和）
- Prime 標準字幕と同時表示する（日本語は画面上端、英語は下端）
- API キーは `chrome.storage.local` に平文保存

## アーキテクチャ

```
background.ts    webRequest で字幕 URL を捕捉
                 タブごとに URL を記憶、CONTENT_READY で再送
                 webNavigation.onHistoryStateUpdated で SPA 遷移を検出して reset
       │
       │ SUBTITLE_DETECTED / TAB_RESET
       ▼
content.ts       Shadow DOM オーバーレイ + 翻訳ボタン
                 ボタン押下で fetch → parseVtt → translateCues
                 timeupdate + 二分探索で表示 cue を切替
                 遷移時は AbortController で進行中翻訳を中断
       │
       ▼
lib/translate.ts Claude Opus 4.7, 50 cue / chunk
                 system prompt はプロンプトキャッシュ (ephemeral)
                 429/5xx/ネットワーク失敗は最大 4 回リトライ
```
