---
title: Privacy Policy — Jimaku
---

# Jimaku — Privacy Policy

_Last updated: 2026-04-23_

Jimaku is a Chrome extension that translates the English subtitle
track of a video the user is watching on Prime Video and overlays the
translated text on top of the player. This document describes what
data Jimaku handles and with whom it is shared.

Jimaku is an independent project and is not affiliated with Amazon,
Anthropic, OpenAI, or OpenRouter.

## TL;DR

- Jimaku does not collect, store, or transmit data to any server
  operated by the developer. There is no backend.
- The extension runs entirely in your browser. Data leaves your
  browser only to the translation provider **you** selected.
- Your API key or OAuth token stays in `chrome.storage.local` on your
  device. It is never sent anywhere except to the provider it
  authenticates.

## Data stored on your device

The following is stored in `chrome.storage.local` in your browser
profile:

- Your selected translation provider (Anthropic / OpenAI /
  OpenRouter)
- Your API key (Anthropic / OpenAI) **or** OAuth access token
  (OpenRouter), in plaintext
- Your selected target language
- UI preferences: auto-translate on/off, show/hide overlay, hide
  original subtitles
- A cache of translated subtitle cues for videos you have watched so
  that re-opening the same episode does not re-trigger translation

This data never leaves your device through any mechanism under the
developer's control. Uninstalling the extension or clearing
`chrome.storage.local` removes all of it.

## Data sent to third parties

### To the translation provider you selected

When translation is active, Jimaku sends English subtitle text from
the video you are currently watching to the provider you selected in
the popup, along with your API key / OAuth token for authentication.
The provider returns translated text, which is displayed in the
overlay.

- Anthropic — [privacy policy](https://www.anthropic.com/legal/privacy)
- OpenAI — [privacy policy](https://openai.com/policies/privacy-policy/)
- OpenRouter — [privacy policy](https://openrouter.ai/privacy)

Jimaku does not modify, proxy, or inspect these requests beyond what
is necessary to construct the API call. The developer has no access
to this traffic.

## Data that is NOT collected

Jimaku does not collect, log, or transmit:

- Your browsing history or activity outside Prime Video player pages
- Your account identity, email, or subscription information on any
  streaming service
- Your IP address, device fingerprint, or any analytics
- Any data to a server operated by the developer

There are no analytics, telemetry, or tracking of any kind in Jimaku.

## Permissions

Why Jimaku requests each permission is documented in the Chrome Web
Store listing. In summary:

- `storage` — to save your settings on your device
- `webRequest` / `webNavigation` / `scripting` — to detect the active
  subtitle track on Prime Video and to manage the overlay across
  single-page-app navigations
- `identity` — to run the OpenRouter OAuth sign-in flow when you
  choose "Connect with OpenRouter"
- Host permissions on streaming, CDN, and provider hosts — required
  for the mechanisms above

## Children

Jimaku is not directed at children under 13 and does not knowingly
process data from them.

## Changes to this policy

Updates will be published at this URL with a new "Last updated"
date. Because Jimaku is open-source, the policy's history is also
visible in the project's git history.

## Contact

Questions or requests related to this policy can be sent to the
developer at `yusukeshib@gmail.com`, or filed as a GitHub issue on
the project repository.
