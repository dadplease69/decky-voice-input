# Voice Input — offline voice typing for Steam Deck

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin. Hold a button combo, speak, release — the text goes into the focused text field (Steam chat, search, browser) or is typed into the game through the Steam keyboard. Speech recognition runs locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on the Deck's GPU; nothing leaves the device.

*Голосовой ввод для Steam Deck: зажмите сочетание кнопок, скажите фразу, отпустите — текст появится в поле ввода. Распознавание офлайн, на видеокарте Deck, русский и английский.*

## Features

- Push-to-talk on any button combo (e.g. L5 + R5), with short start/stop sounds instead of popups.
- Works with the Steam on-screen keyboard open and inside games (reads the Deck controller directly).
- GPU (Vulkan) recognition: ~0.7–0.9 s per phrase with the Small model; CPU engine as a fallback.
- Whisper models Base / Small / Medium / Large v3 turbo, downloaded from the panel (60–575 MB).
- Memory control: unload the model after 10 s … 1 h of inactivity, right after each phrase, or keep it loaded; current RAM/VRAM usage is shown in the panel.
- Russian, English or automatic language detection.

## Usage

1. Open the plugin panel and download a model (Small is a good default).
2. Press **Assign combo**, release A, then hold the buttons you want (at least two) and release.
3. Hold the combo anywhere, speak, release.

## How it works

| Part | What it does |
|---|---|
| `src/index.tsx` | Panel UI, push-to-talk logic, text delivery: inserts into the focused Steam text field, otherwise types through `SteamClient.Input.ControllerKeyboardSendText` (same path as the Steam keyboard, Unicode-capable). |
| `main.py` | Records with `pw-record` in the user's PipeWire session, runs `whisper-server` (loaded on first press, warmed up, unloaded when idle), downloads models, plays sounds with `pw-play`. |
| hidraw reader (`main.py`) | Reads the Deck controller's HID reports (layout of the kernel `hid-steam` driver). hidraw gives every report to every reader, so Steam keeps working normally; this lets the combo work while the Steam keyboard is open. |
| `py_modules/uinput_typer.py` | Optional last-resort fallback: a virtual keyboard on `/dev/uinput` (Latin only). |
| `bin/whisper-server-{vulkan,cpu}` | whisper.cpp server, built from source by `.github/workflows/engine.yml` and bundled through `remote_binary` in `package.json` (SHA-256 pinned). |

**Why root:** reading `/dev/hidraw*` (controller) and creating `/dev/uinput` (fallback keyboard) need it. Audio recording/playback runs as the desktop user.

## Building

```bash
pnpm i
pnpm run build          # frontend -> dist/index.js
```

Releases: `git tag engine-vN` builds the engine (`engine.yml`), `git tag vX.Y.Z` packs the plugin zip (`release.yml`).

Development helpers live in `scripts/` (`dev-sync.ps1` pushes changes to a Deck over SSH and rebuilds there).

## Credits and licenses

Plugin: MIT. whisper.cpp: MIT. Whisper models: MIT (OpenAI). Build configuration based on decky-plugin-template (BSD-3-Clause). See `LICENSE`.

The code of this plugin was written with substantial help from an AI assistant (Claude), then tested and debugged on a real Steam Deck by the author.
