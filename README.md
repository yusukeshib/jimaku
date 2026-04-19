# Subtitle

A Chrome extension that translates video subtitles into Japanese in real time using Claude, and overlays them on top of the player.

## Install

The extension isn't on the Chrome Web Store yet. To install it manually:

1. Download the latest build (`dist/` folder) from the [Releases](../../releases) page, or build it yourself with `npm install && npm run build`.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `dist/` folder.

## Setup

1. Get an Anthropic API key from [console.anthropic.com](https://console.anthropic.com/).
2. Click the extension icon, open **Options**, and paste your API key.

Your key is stored locally in your browser and is only sent to Anthropic when translating.

## Usage

1. Open a supported video and start playback with the original subtitles turned on.
2. Click the **Translate** button that appears on the player.
3. Japanese subtitles appear at the top of the frame; the original subtitles stay at the bottom.

Translation happens in chunks, so the first lines show up within a few seconds and the rest fill in as you watch.

## Supported subtitle formats

- WebVTT
- TTML / DFXP
- HLS WebVTT (playlists with segmented `.vtt` files)

## Known limitations

- Occasional chunks may fall back to the original English if the model's response is malformed.
- The API key is stored in plain text in `chrome.storage.local`. Don't use this extension on a shared browser profile.
- Translation uses the Anthropic API and will count against your API usage / billing.
- Some TTML timing variants (SMPTE time) aren't supported.
