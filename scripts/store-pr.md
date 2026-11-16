# Add Voice Input to Plugin Store

## Summary

**Voice Input** — offline voice typing for Steam Deck. Hold a button combo (e.g. L5 + R5), speak, release: the text is inserted into the focused text field (Steam chat, search, browser) or typed into the game through the Steam keyboard. Speech recognition runs locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on the Deck GPU (Vulkan), ~0.7–0.9 s per phrase with the Small model; nothing leaves the device.

- Push-to-talk on any combo, short start/stop sounds instead of popups
- Works with the Steam on-screen keyboard open and inside games
- Whisper models (Base / Small / Medium / Large v3 turbo) downloaded from the panel from huggingface.co/ggerganov/whisper.cpp
- Memory control: unload after 10 s – 1 h idle, after each phrase, or keep loaded; RAM/VRAM usage shown
- Russian, English or auto-detected language

**Similar plugins:** Decky-Dictation (Vosk) was removed from the store and is no longer maintained. Voice Input uses Whisper (much better accuracy, especially for non-English), GPU inference, and keeps the plugin itself small (models are downloaded on demand).

Repository: https://github.com/dadplease69/decky-voice-input

### Implementation notes for reviewers

- **Root** is needed to read the Deck controller from `/dev/hidraw*` (Steam stops forwarding controller messages to plugins while its on-screen keyboard is open; hidraw delivers every report to every reader, so Steam is not affected) and for the optional `/dev/uinput` fallback keyboard. Audio recording/playback (`pw-record`/`pw-play`) runs as the desktop user.
- **Binaries:** `bin/whisper-server-vulkan` and `bin/whisper-server-cpu` are built from whisper.cpp sources by the repository's GitHub Actions (`.github/workflows/engine.yml`) and bundled via `remote_binary` in `package.json` with pinned SHA-256. libstdc++/libgcc are static; glibc and (for the Vulkan build) `libvulkan.so.1` are linked dynamically from the system.
- Text is delivered either directly into the focused Steam text field or via `SteamClient.Input.ControllerKeyboardSendText` (the same path the Steam keyboard uses). The Steam keyboard itself is not patched.

### AI disclosure

The plugin's code was written with substantial help from an AI assistant (Claude). I designed the feature set, made the decisions, tested and debugged everything on my own Steam Deck, and I maintain the code. I'm stating this openly because the checklist item below doesn't apply; I understand if that means the plugin can't be accepted.

## Task Checklist

### Developer

- [x] I am the original author or an authorized maintainer of this plugin.
- [x] I have abided by the licenses of the libraries I am utilizing, including attaching license notices where appropriate.
- [ ] Generative AI was not used to write a majority of the submitted code. — **Not true for this plugin, see "AI disclosure" above.**

### Plugin

- [ ] I have verified that my plugin works properly on the Stable and Beta update channels of SteamOS. — Tested on SteamOS __CHANNEL__ (Steam Deck __MODEL__).
- [x] I have verified my plugin is unique or provides more/alternative functionality to a plugin already on the store.

### Backend

- [ ] No: I am using a custom backend other than Python.
- [x] Yes: I am using a tool or software from a 3rd party FOSS project that does not have its dependencies statically linked. (whisper.cpp server: glibc and libvulkan are dynamic)
- [ ] No: I am using a custom binary that has all of it's dependencies statically linked.

### Community

- [ ] I have tested and left feedback on two other pull requests for new or updating plugins.
- [ ] I have commented links to my testing report in this PR.

## Testing

- [ ] Third-party tested on SteamOS Preview channel.
