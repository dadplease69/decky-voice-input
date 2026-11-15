# Voice Input — голосовой ввод для Steam Deck

Плагин [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader): офлайн-распознавание речи на [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Удерживаете сочетание кнопок, говорите, отпускаете — текст попадает в поле в фокусе (чат Steam, поиск, браузер) или набирается в игре через клавиатуру Steam, включая кириллицу.

Клавиатуру Steam плагин не патчит, поэтому обновления клиента его не ломают.

## Возможности

- Push-to-talk на любом сочетании кнопок (например L5 + R5), звуковые сигналы начала и конца записи.
- Распознавание на видеокарте Deck (Vulkan): ~0,7–0,9 с на фразу; запасной движок на процессоре.
- Модели Whisper Base / Small / Medium / Large v3 turbo, скачиваются из панели.
- Управление памятью: выгрузка через 10 с / 1–60 мин простоя, сразу или «всегда в памяти»; прогрев после загрузки, кэш шейдеров.

## Установка

Пока плагина нет в официальном магазине — через свой канал:

1. Decky → Настройки → General → **Store channel: Custom**.
2. Custom store URL: `https://raw.githubusercontent.com/dadplease69/decky-voice-input/main/store/store.json`
3. Магазин Decky → Voice Input → Install.
4. Панель плагина: «Установить движок для видеокарты» → «Скачать модель» → «Назначить сочетание».

## Как устроено

- `dist/index.js` — фронтенд (ES-модуль без сборщика): панель, сочетание кнопок через `SteamClient.Input.RegisterForControllerInputMessages`, вставка текста в активное поле или `ControllerKeyboardSendText`.
- `main.py` — бэкенд: запись `pw-record`, `whisper-server`, скачивание моделей и движка (с проверкой SHA-256), звуки `pw-play`.
- Движок публикуется отдельным релизом `engine-v*` (`.github/workflows/engine.yml`), плагин — тегами `v*` (`release.yml`).

## Релизы

```bash
git tag engine-v1 && git push origin engine-v1   # движок (тег = ENGINE_TAG в main.py)
git tag v0.1.0 && git push origin v0.1.0         # плагин (= version в package.json)
```

## Разработка

- `scripts/dev-sync.ps1` — автозаливка на Deck по SSH при каждом изменении файлов, логи в `deck-logs/`.
- `scripts/setup-deck.sh` — одноразовая настройка Deck для `dev-sync`.
- `scripts/build-whisper*.sh` — локальная сборка движка в контейнере (podman/docker).

## Лицензии

Плагин — MIT. whisper.cpp — MIT. Модели Whisper — MIT (OpenAI), загружаются с huggingface.co/ggerganov/whisper.cpp.
