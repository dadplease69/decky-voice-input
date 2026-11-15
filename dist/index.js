// Decky Voice Input — frontend.
// Hand-written ES module, no bundler: uses the same globals the official
// @decky/rollup config maps to (SP_REACT, DFL) and the loader API connection
// that @decky/api uses internally. Only stable Decky APIs, no patching of
// the Steam on-screen keyboard.

const React = window.SP_REACT;
const DFL = window.DFL;
const h = React.createElement;
const PLUGIN_NAME = "Voice Input";

// ---------------------------------------------------------------- loader API (same as @decky/api)
const conn = window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit;
if (!conn) throw new Error("[voice-input] Decky loader API not available");
let api;
try {
  api = conn.connect(2, PLUGIN_NAME);
} catch (e) {
  api = conn.connect(1, PLUGIN_NAME);
}

const rpc = {};
for (const m of ["get_state", "set_setting", "download_model", "delete_model", "download_engine", "delete_engine",
  "load_model", "unload_model", "start_recording", "stop_recording", "cancel_recording", "type_text", "play_sound", "log"]) {
  rpc[m] = api.callable(m);
}

function log(msg, level = "info") {
  console.log("[voice-input]", msg);
  rpc.log(level, String(msg)).catch(() => {});
}

// Toasts only for problems — normal operation is signalled by sounds.
function toast(title, body) {
  try {
    api.toaster.toast({ title, body: body || "", duration: 4000 });
  } catch (e) {
    log("toast failed: " + e, "warning");
  }
}

// ---------------------------------------------------------------- tiny store
const store = {
  state: null, // backend get_state()
  phase: "idle", // idle | recording | transcribing
  source: null,
  last: null,
  learning: false,
  listeners: new Set(),
  set(patch) {
    Object.assign(this, patch);
    this.listeners.forEach((f) => f());
  },
};

function useStore() {
  const [, force] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => {
    store.listeners.add(force);
    return () => store.listeners.delete(force);
  }, []);
  return store;
}

async function refresh() {
  try {
    const state = await rpc.get_state();
    store.set({ state });
    loadCombo(state.settings.hotkey);
  } catch (e) {
    log("get_state failed: " + e, "error");
  }
}

// ---------------------------------------------------------------- text delivery
function candidateWindows() {
  const wins = [];
  try {
    const sp = DFL.findSP && DFL.findSP();
    if (sp) wins.push(sp);
  } catch (e) {}
  try {
    const fnc = window.FocusNavController;
    const contexts = [];
    if (fnc) {
      if (fnc.m_ActiveContext) contexts.push(fnc.m_ActiveContext);
      for (const c of fnc.m_rgAllContexts || []) if (!contexts.includes(c)) contexts.push(c);
    }
    for (const ctx of contexts) {
      for (const tree of ctx.m_rgGamepadNavigationTrees || []) {
        const w = tree && tree.Root && tree.Root.Element && tree.Root.Element.ownerDocument && tree.Root.Element.ownerDocument.defaultView;
        if (w && w.document && !wins.includes(w)) wins.push(w);
      }
    }
  } catch (e) {}
  if (!wins.includes(window)) wins.push(window);
  const focused = (w) => {
    try {
      return w.document.hasFocus() ? 0 : 1;
    } catch (e) {
      return 2;
    }
  };
  return wins.sort((a, b) => focused(a) - focused(b));
}

function describeWindows() {
  return candidateWindows()
    .map((w, i) => {
      try {
        const el = w.document.activeElement;
        const d = el ? `${el.tagName}${el.type ? "[" + el.type + "]" : ""}` : "none";
        return `#${i} focus=${w.document.hasFocus()} active=${d}`;
      } catch (e) {
        return `#${i} err`;
      }
    })
    .join(" | ");
}

function insertIntoFocused(text) {
  for (const w of candidateWindows()) {
    let el;
    try {
      el = w.document.activeElement;
    } catch (e) {
      continue;
    }
    if (!el) continue;
    const tag = el.tagName;
    if ((tag === "INPUT" && /^(text|search|url|email|)$/i.test(el.type || "")) || tag === "TEXTAREA") {
      const proto = tag === "INPUT" ? w.HTMLInputElement.prototype : w.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const value = el.value || "";
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? start;
      const sep = start > 0 && !/\s$/.test(value.slice(0, start)) ? " " : "";
      const insert = sep + text;
      setter.call(el, value.slice(0, start) + insert + value.slice(end));
      el.dispatchEvent(new w.Event("input", { bubbles: true })); // React-controlled inputs
      try {
        el.setSelectionRange(start + insert.length, start + insert.length);
      } catch (e) {}
      log(`inserted into <${tag.toLowerCase()}>`);
      return true;
    }
    if (el.isContentEditable) {
      w.document.execCommand("insertText", false, text);
      log("inserted into contenteditable");
      return true;
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Mimic the on-screen keyboard: one character per call, small gap between calls.
// Sending the whole string at once makes Steam drop / duplicate / reorder characters.
async function steamSendText(text) {
  const input = window.SteamClient && window.SteamClient.Input;
  if (!input || typeof input.ControllerKeyboardSendText !== "function") return false;
  try {
    for (const ch of text) {
      input.ControllerKeyboardSendText(ch);
      await sleep(18);
    }
    return true;
  } catch (e) {
    log("ControllerKeyboardSendText failed: " + e, "error");
    return false;
  }
}

async function deliver(text) {
  if (insertIntoFocused(text)) return;
  log("no DOM field: " + describeWindows());
  const st = store.state && store.state.settings;
  if ((!st || st.delivery !== "uinput") && (await steamSendText(text))) {
    log("sent via ControllerKeyboardSendText");
    return;
  }
  if (st && st.type_in_games) {
    const r = await rpc.type_text(text);
    if (r.ok) return;
    log("game typing skipped: " + r.error);
  }
  toast("Текст не удалось вставить", text);
}

// ---------------------------------------------------------------- recording flow
async function beginRecording(source) {
  if (store.phase !== "idle") return;
  store.set({ phase: "recording", source });
  const r = await rpc.start_recording();
  if (!r.ok) {
    store.set({ phase: "idle", source: null });
    toast("Запись не началась", r.error);
  }
}

async function endRecording() {
  if (store.phase !== "recording") return;
  const source = store.source;
  store.set({ phase: "transcribing" });
  const r = await rpc.stop_recording();
  store.set({ phase: "idle", source: null });
  if (!r.ok) {
    if (!r.quiet) toast("Не распознано", r.error);
    return;
  }
  if (!r.text) {
    rpc.play_sound("error");
    return;
  }
  store.set({ last: r });
  log(`transcribed ${r.audio_seconds}s audio in ${r.seconds}s`);
  if (source === "hotkey") await deliver(r.text);
}

// ---------------------------------------------------------------- hotkey (push-to-talk)
// SteamClient.Input.RegisterForControllerInputMessages delivers button codes (nA).
// Codes measured on a Steam Deck (SteamOS, Nov 2026); unknown ones are shown as "кнопка N".
const BUTTON_NAMES = {
  a0: "A", a1: "B", a2: "X", a3: "Y",
  a30: "L1", a31: "R1", a28: "L2", a29: "R2",
  a25: "L3", a41: "R3",
  a44: "L4", a45: "R4", a32: "L5", a33: "R5",
  a20: "↑", a21: "↓", a22: "←", a23: "→",
  a35: "View", a36: "Menu",
};
// Order for display: shoulders/back first, then face buttons, then the rest
const BUTTON_ORDER = ["a44", "a45", "a32", "a33", "a30", "a31", "a28", "a29", "a25", "a41", "a0", "a1", "a2", "a3", "a35", "a36", "a20", "a21", "a22", "a23"];
let combo = null; // array of keys, null = not assigned
let held = false;
let learn = null; // {keys:Set, seen, armed}
let unregister = null;
let apiMode = "none";
const pressed = new Set();
let debugLeft = 0;

function loadCombo(hk) {
  combo = hk && Array.isArray(hk.keys) && hk.keys.length ? hk.keys : null;
}

function comboText(keys) {
  const rank = (k) => (BUTTON_ORDER.indexOf(k) + 1 || 999);
  return [...keys].sort((a, b) => rank(a) - rank(b)).map((k) => BUTTON_NAMES[k] || "кнопка " + k.slice(1)).join(" + ");
}

async function finishLearn() {
  const keys = [...learn.keys].sort();
  learn = null;
  store.set({ learning: false });
  log("learned keys: " + keys.join(","));
  if (keys.length < 2) {
    rpc.play_sound("error");
    toast("Нужно минимум две кнопки", "Например L4 + R4, чтобы не мешать игре");
    return;
  }
  const hk = { keys, count: keys.length };
  await rpc.set_setting("hotkey", hk);
  loadCombo(hk);
  rpc.play_sound("stop");
  await refresh();
}

let probeSeq = 0;
function onPressedChanged() {
  if (debugLeft > 0) {
    debugLeft--;
    log(`pressed: ${[...pressed].join(",") || "-"}`);
  }
  if (store.probing) {
    if (pressed.size) {
      probeSeq++;
      log(`PROBE #${probeSeq}: ${[...pressed].join(",")}`);
      store.set({ probeLast: comboText([...pressed]) + ` (#${probeSeq})` });
    }
    return; // don't trigger recording while probing
  }
  if (learn) {
    if (!learn.armed) {
      if (!pressed.size) learn.armed = true; // wait until the A press that opened learn mode is released
      return;
    }
    if (pressed.size) {
      pressed.forEach((k) => learn.keys.add(k));
      learn.seen = true;
    } else if (learn.seen) {
      finishLearn();
    }
    return;
  }
  if (!combo) return;
  const match = combo.every((k) => pressed.has(k));
  if (match && !held) {
    held = true;
    beginRecording("hotkey");
  } else if (!match && held) {
    held = false;
    endRecording();
  }
}

function bitsToKeys(prefix, v, out) {
  let x;
  try {
    x = BigInt(v || 0);
  } catch (e) {
    return;
  }
  let i = 0;
  while (x) {
    if (x & 1n) out.add(prefix + i);
    x >>= 1n;
    i++;
  }
}

function onControllerStates(states) {
  pressed.clear();
  for (const s of states || []) {
    bitsToKeys("b", s.ulButtons, pressed);
    bitsToKeys("u", s.ulUpperButtons, pressed);
  }
  onPressedChanged();
}

function onInputMessages(a, b, c) {
  const msgs = Array.isArray(a) ? a : [{ nA: b, bS: c, nC: a }];
  for (const m of msgs) {
    const btn = m.nA ?? m.eAction ?? m.button;
    const down = m.bS ?? m.bState ?? m.pressed;
    if (btn == null) continue;
    const key = "a" + btn;
    if (down) pressed.add(key);
    else pressed.delete(key);
  }
  onPressedChanged();
}

function registerHotkey() {
  const input = window.SteamClient && window.SteamClient.Input;
  if (!input) {
    log("SteamClient.Input missing", "error");
    return;
  }
  const tryReg = (fn, cb, mode) => {
    if (typeof input[fn] !== "function") return false;
    try {
      const reg = input[fn](cb);
      unregister = () => reg && reg.unregister && reg.unregister();
      apiMode = mode;
      log("hotkey via " + fn);
      return true;
    } catch (e) {
      log(fn + " failed: " + e, "error");
      return false;
    }
  };
  if (!tryReg("RegisterForControllerInputMessages", onInputMessages, "msg")) {
    if (!tryReg("RegisterForControllerStateChanges", onControllerStates, "state")) {
      log("no usable controller input API", "error");
    }
  }
}

// ---------------------------------------------------------------- UI
function MicIcon() {
  return h(
    "svg",
    { viewBox: "0 0 24 24", width: "1em", height: "1em", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
    h("rect", { x: 9, y: 3, width: 6, height: 11, rx: 3 }),
    h("path", { d: "M5 10a7 7 0 0 0 14 0" }),
    h("path", { d: "M12 17v4" }),
    h("path", { d: "M8 21h8" })
  );
}

const { PanelSection, PanelSectionRow, ButtonItem, ToggleField, DropdownItem, Field } = DFL;
const Row = (child) => h(PanelSectionRow, null, child);

const LANGS = [
  { data: "ru", label: "Русский" },
  { data: "en", label: "English" },
  { data: "auto", label: "Автоопределение" },
];
const KEEP = [
  { data: 0, label: "Выгружать сразу" },
  { data: 10, label: "10 секунд" },
  { data: 60, label: "1 минута" },
  { data: 300, label: "5 минут" },
  { data: 900, label: "15 минут" },
  { data: 3600, label: "1 час" },
  { data: -1, label: "Всегда в памяти" },
];
const ENGINE_LABEL = { vulkan: "Видеокарта (Vulkan)", cpu: "Процессор" };

function fmtLeft(sec) {
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `${sec} с` : `${Math.ceil(sec / 60)} мин`;
}

function statusText(s) {
  const st = s.state;
  if (!st.engine_variant) return "Установите движок ниже";
  const model = st.models.find((m) => m.id === st.settings.model);
  if (!model || !model.installed) return "Скачайте модель ниже";
  if (!combo) return "Назначьте сочетание кнопок";
  if (s.learning) return "Отпустите A, затем зажмите кнопки";
  if (s.phase === "recording") return "Слушаю…";
  if (s.phase === "transcribing") return "Распознаю…";
  return "Готов · " + comboText(combo);
}

function downloadButton(st, kind, id, idleLabel, onStart) {
  const dl = st.download || {};
  const active = dl.kind === kind && dl.id === id && !dl.error && dl.progress < 1;
  const busy = dl.kind && !dl.error && dl.progress > 0 && dl.progress < 1;
  return h(
    ButtonItem,
    { layout: "below", disabled: busy, onClick: onStart },
    active ? `Скачиваю… ${Math.round(dl.progress * 100)}%` : idleLabel
  );
}

function Content() {
  const s = useStore();
  React.useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000); // live memory / idle numbers while the panel is open
    return () => clearInterval(t);
  }, []);
  const st = s.state;
  if (!st) return h(PanelSection, null, Row(h(Field, { label: "Загрузка…" })));

  const settings = st.settings;
  const model = st.models.find((m) => m.id === settings.model) || st.models[0];
  const dl = st.download || {};
  const ready = st.engine_variant && model.installed;
  const set = async (k, v) => {
    await rpc.set_setting(k, v);
    refresh();
  };
  const srv = st.server || {};
  const memText = srv.running
    ? `${(st.models.find((m) => m.id === srv.model) || {}).label || srv.model} · ${ENGINE_LABEL[srv.variant] || srv.variant}\nОЗУ ${srv.rss_mb} МБ` +
      (srv.gpu_mb ? ` · видео ${srv.gpu_mb} МБ` : "") +
      (settings.keep_loaded_sec > 0 ? ` · выгрузка через ${fmtLeft(settings.keep_loaded_sec - srv.idle_sec)}` : "")
    : "Не загружена — загрузится при нажатии сочетания";

  return h(
    React.Fragment,
    null,
    // --- main
    h(
      PanelSection,
      { title: "Голосовой ввод" },
      Row(h(Field, { label: "Статус", description: statusText(s) })),
      Row(
        s.phase === "recording"
          ? h(ButtonItem, { layout: "below", onClick: () => endRecording() }, "Остановить и распознать")
          : h(ButtonItem, { layout: "below", disabled: !ready || s.phase !== "idle", onClick: () => beginRecording("panel") }, s.phase === "transcribing" ? "Распознаю…" : "Записать из панели")
      ),
      s.last && Row(h(Field, { label: `Последний текст · ${s.last.seconds} с`, description: s.last.text }))
    ),
    // --- hotkey
    h(
      PanelSection,
      { title: "Сочетание кнопок" },
      Row(h(Field, { label: "Удерживайте для записи", description: combo ? comboText(combo) : "Не назначено" })),
      Row(
        h(
          ButtonItem,
          {
            layout: "below",
            disabled: s.learning,
            onClick: () => {
              if (apiMode === "none") {
                toast("Нет доступа к кнопкам", "Steam не дал API контроллера");
                return;
              }
              learn = { keys: new Set(), seen: false, armed: false };
              pressed.clear();
              debugLeft = 40;
              store.set({ learning: true });
            },
          },
          s.learning ? "Жду кнопки…" : combo ? "Изменить сочетание" : "Назначить сочетание"
        )
      )
    ),
    // --- model
    h(
      PanelSection,
      { title: "Модель" },
      Row(
        h(DropdownItem, {
          label: "Модель",
          rgOptions: st.models.map((m) => ({ data: m.id, label: `${m.installed ? "✓ " : ""}${m.label}` })),
          selectedOption: settings.model,
          onChange: (o) => set("model", o.data),
        })
      ),
      Row(
        model.installed
          ? h(ButtonItem, { layout: "below", onClick: async () => { await rpc.delete_model(model.id); refresh(); } }, `Удалить модель (${model.size_mb} МБ)`)
          : downloadButton(st, "model", model.id, `Скачать модель (~${model.size_mb} МБ)`, async () => { await rpc.download_model(model.id); refresh(); })
      ),
      dl.error && dl.kind === "model" && Row(h(Field, { label: "Ошибка скачивания", description: dl.error })),
      Row(h(DropdownItem, { label: "Язык", rgOptions: LANGS, selectedOption: settings.language, onChange: (o) => set("language", o.data) }))
    ),
    // --- engine + memory
    h(
      PanelSection,
      { title: "Движок и память" },
      Row(
        h(Field, {
          label: "Движок",
          description: st.engine_variant ? ENGINE_LABEL[st.engine_variant] + (st.gpu_failed ? " (видеокарта не запустилась)" : "") : "Не установлен",
        })
      ),
      !st.engines.vulkan && Row(downloadButton(st, "engine", "vulkan", "Установить движок для видеокарты", async () => { await rpc.download_engine("vulkan"); refresh(); })),
      !st.engines.cpu && Row(downloadButton(st, "engine", "cpu", "Установить запасной движок (процессор)", async () => { await rpc.download_engine("cpu"); refresh(); })),
      dl.error && dl.kind === "engine" && Row(h(Field, { label: "Ошибка установки движка", description: dl.error })),
      st.engines.vulkan &&
        Row(
          h(ToggleField, {
            label: "Использовать видеокарту",
            description: "В 5–7 раз быстрее процессора",
            checked: !!settings.gpu,
            onChange: (v) => set("gpu", v),
          })
        ),
      Row(
        h(DropdownItem, {
          label: "Держать модель в памяти",
          rgOptions: KEEP,
          selectedOption: settings.keep_loaded_sec,
          onChange: (o) => set("keep_loaded_sec", o.data),
        })
      ),
      Row(h(Field, { label: "Сейчас в памяти", description: memText })),
      Row(
        srv.running
          ? h(ButtonItem, { layout: "below", disabled: s.phase !== "idle", onClick: async () => { await rpc.unload_model(); refresh(); } }, "Выгрузить сейчас")
          : h(ButtonItem, { layout: "below", disabled: !ready, onClick: async () => { const r = await rpc.load_model(); if (!r.ok) toast("Не загрузилась", r.error); refresh(); } }, "Загрузить сейчас")
      )
    ),
    // --- extra
    h(
      PanelSection,
      { title: "Дополнительно" },
      Row(h(ToggleField, { label: "Звуковые сигналы", description: "Начало и конец записи", checked: settings.sounds !== false, onChange: (v) => set("sounds", v) })),
      Row(h(ToggleField, { label: "Быстрое распознавание", description: "Быстрее, но может повторять и путать слова", checked: !!settings.fast_mode, onChange: (v) => set("fast_mode", v) })),
      Row(h(ToggleField, { label: "Печатать в играх (латиница)", description: "Запасной способ, если Steam не принял текст", checked: settings.type_in_games, onChange: (v) => set("type_in_games", v) }))
    )
  );
}

// ---------------------------------------------------------------- plugin entry
function onDownloadProgress(ds) {
  if (store.state) store.set({ state: { ...store.state, download: ds } });
  if (ds.error) toast(ds.kind === "engine" ? "Движок не установился" : "Модель не скачалась", ds.error);
  if (ds.progress >= 1 || ds.error) refresh();
}

function onEngineFallback(err) {
  toast("Видеокарта не сработала", "Переключился на процессор: " + err);
  refresh();
}

export default function () {
  api.addEventListener("download_progress", onDownloadProgress);
  api.addEventListener("engine_fallback", onEngineFallback);
  registerHotkey();
  refresh();
  return {
    name: PLUGIN_NAME,
    titleView: h("div", { className: DFL.staticClasses && DFL.staticClasses.Title }, "Голосовой ввод"),
    content: h(Content),
    icon: h(MicIcon),
    onDismount() {
      try {
        api.removeEventListener("download_progress", onDownloadProgress);
        api.removeEventListener("engine_fallback", onEngineFallback);
      } catch (e) {}
      if (unregister) unregister();
      if (store.phase === "recording") rpc.cancel_recording();
    },
  };
}
