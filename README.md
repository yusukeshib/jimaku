# Jimaku

A Chrome extension that translates video subtitles into your chosen language in real time using AI, and overlays them on top of the player.

## Supported platforms

- **Prime Video** — subtitles are intercepted from the player's network requests.
- **Netflix** — subtitles are fetched from [OpenSubtitles](https://www.opensubtitles.org) keyed on the title and episode (Netflix's own subtitles aren't reachable; they're delivered inside an encrypted manifest).

## Install

The extension isn't on the Chrome Web Store yet. To install it manually:

1. Download the latest build (`dist/` folder) from the [Releases](../../releases) page, or build it yourself with `npm install && npm run build`.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `dist/` folder.

## Setup

Click the extension icon and pick a translation provider:

- **OpenRouter** — one-click OAuth, no key handling required.
- **Anthropic** — paste an API key from [console.anthropic.com](https://console.anthropic.com/).
- **OpenAI** — paste an API key from [platform.openai.com](https://platform.openai.com/).

Your key is stored locally in your browser and is only sent to the provider you chose.

## Usage

1. Open a supported video and start playback (with English captions enabled — they're the source we translate from).
2. The popup shows progress; translated lines stream in as the model returns them.
3. Toggle "Show translated overlay" and "Hide original subtitles" in the popup to taste — language-learning mode (both visible) and replacement mode (translated only) are both supported.

## Supported subtitle formats

- WebVTT
- SRT
- TTML / DFXP
- HLS WebVTT (playlists with segmented `.vtt` files)

## Known limitations

- Occasional chunks may fall back to the original text if the model's response is malformed.
- The API key is stored in plain text in `chrome.storage.local`. Don't use this extension on a shared browser profile.
- Translation uses your chosen provider's API and counts against your usage / billing.
- Some TTML timing variants (SMPTE time) aren't supported.
- For Netflix, the subtitle file is matched by title + season + episode against OpenSubtitles. Coverage and edit-version mismatches can occur; the extension auto-calibrates timing offset against Netflix's own captions, but obscure or pre-release titles may not have a usable match.
