import {
  ButtonItem,
  DropdownItem,
  Field,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  findSP,
  staticClasses,
} from "@decky/ui";
import { addEventListener, callable, definePlugin, removeEventListener, toaster } from "@decky/api";
import { useEffect, useReducer } from "react";
import { FaMicrophone } from "react-icons/fa";

// ---------------------------------------------------------------- backend API
type ModelInfo = { id: string; label: string; size_mb: number; installed: boolean };
type DownloadState = { id: string | null; progress: number; error: string | null };
type ServerInfo = { running: boolean; model: string | null; variant: string | null; rss_mb: number; gpu_mb: number; idle_sec: number | null };
type Settings = {
  model: string;
  language: string;
  hotkey: { keys: string[] } | null;
  type_in_games: boolean;
  keep_loaded_sec: number;
  threads: number;
  gpu: boolean;
  sounds: boolean;
};
type State = {
  settings: Settings;
  models: ModelInfo[];
  engines: { vulkan: boolean; cpu: boolean };
  engine_variant: "vulkan" | "cpu" | null;
  gpu_failed: boolean;
  server: ServerInfo;
  is_root: boolean;
  download: DownloadState;
};
type Result = { ok: boolean; error?: string };
type Transcript = Result & { text?: string; seconds?: number; audio_seconds?: number; quiet?: boolean };

const getState = callable<[], State>("get_state");
const setSetting = callable<[key: string, value: unknown], Result>("set_setting");
const downloadModel = callable<[id: string], Result>("download_model");
const deleteModel = callable<[id: string], Result>("delete_model");
const loadModel = callable<[], Result>("load_model");
const unloadModel = callable<[], Result>("unload_model");
const startRecording = callable<[], Result>("start_recording");
const stopRecording = callable<[], Transcript>("stop_recording");
const cancelRecording = callable<[], Result>("cancel_recording");
const typeText = callable<[text: string], Result>("type_text");
const playSound = callable<[name: string], boolean>("play_sound");
const backendLog = callable<[level: string, msg: string], boolean>("log");

function log(msg: string, level: "info" | "warning" | "error" = "info") {
  console.log("[voice-input]", msg);
  backendLog(level, msg).catch(() => {});
}

// Toasts only for problems — normal operation is signalled by sounds.
function toast(title: string, body: string) {
  toaster.toast({ title, body, duration: 4000 });
}

// ---------------------------------------------------------------- tiny store shared by panel and hotkey
type Phase = "idle" | "recording" | "transcribing";
interface StoreData {
  state: State | null;
  phase: Phase;
  source: "hotkey" | "panel" | null;
  last: Transcript | null;
  learning: boolean;
}
interface Store extends StoreData {
  listeners: Set<() => void>;
  set(patch: Partial<StoreData>): void;
}
const store: Store = {
  state: null,
  phase: "idle",
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
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    store.listeners.add(force);
    return () => {
      store.listeners.delete(force);
    };
  }, []);
  return store;
}

async function refresh() {
  try {
    const state = await getState();
    store.set({ state });
    loadCombo(state.settings.hotkey);
  } catch (e) {
    log("get_state failed: " + e, "error");
  }
}

// ---------------------------------------------------------------- text delivery
// Steam UI internals used here are not typed by @decky/ui, hence the loose access.
type AnyWindow = Window & typeof globalThis;

function steamWindows(): AnyWindow[] {
  const wins: AnyWindow[] = [];
  const add = (w: AnyWindow | null | undefined) => {
    if (w && w.document && !wins.includes(w)) wins.push(w);
  };
  try {
    add(findSP() as AnyWindow);
  } catch (e) {}
  try {
    // Every Steam UI window (main, chat popups, ...) has a gamepad navigation tree.
    const fnc = (window as any).FocusNavController;
    const contexts: any[] = fnc ? [fnc.m_ActiveContext, ...(fnc.m_rgAllContexts || [])] : [];
    for (const ctx of contexts) {
      for (const tree of ctx?.m_rgGamepadNavigationTrees || []) {
        add(tree?.Root?.Element?.ownerDocument?.defaultView);
      }
    }
  } catch (e) {}
  add(window);
  const rank = (w: AnyWindow) => {
    try {
      return w.document.hasFocus() ? 0 : 1;
    } catch (e) {
      return 2;
    }
  };
  return wins.sort((a, b) => rank(a) - rank(b));
}

function insertIntoFocused(text: string): boolean {
  for (const w of steamWindows()) {
    let el: Element | null = null;
    try {
      el = w.document.activeElement;
    } catch (e) {
      continue;
    }
    if (!el) continue;
    const isInput = el instanceof w.HTMLInputElement && /^(text|search|url|email|)$/i.test(el.type || "");
    if (isInput || el instanceof w.HTMLTextAreaElement) {
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      const proto = isInput ? w.HTMLInputElement.prototype : w.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (!setter) continue;
      const value = field.value || "";
      const start = field.selectionStart ?? value.length;
      const end = field.selectionEnd ?? start;
      const sep = start > 0 && !/\s$/.test(value.slice(0, start)) ? " " : "";
      const insert = sep + text;
      setter.call(field, value.slice(0, start) + insert + value.slice(end));
      field.dispatchEvent(new w.Event("input", { bubbles: true })); // React-controlled inputs
      try {
        field.setSelectionRange(start + insert.length, start + insert.length);
      } catch (e) {}
      log(`inserted into <${el.tagName.toLowerCase()}>`);
      return true;
    }
    if ((el as HTMLElement).isContentEditable) {
      w.document.execCommand("insertText", false, text);
      log("inserted into contenteditable");
      return true;
    }
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Same path as Steam's on-screen keyboard: one character per call. Sending a whole string
// at once makes Steam drop, duplicate or reorder characters.
async function steamKeyboardType(text: string): Promise<boolean> {
  const input = (window as any).SteamClient?.Input;
  if (typeof input?.ControllerKeyboardSendText !== "function") return false;
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

async function deliver(text: string) {
  if (insertIntoFocused(text)) return;
  if (await steamKeyboardType(text)) {
    log("typed via Steam keyboard");
    return;
  }
  if (store.state?.settings.type_in_games) {
    const r = await typeText(text);
    if (r.ok) return;
    log("virtual keyboard skipped: " + r.error);
  }
  toast("Текст не удалось вставить", text);
}

// ---------------------------------------------------------------- recording flow
async function beginRecording(source: "hotkey" | "panel") {
  if (store.phase !== "idle") return;
  store.set({ phase: "recording", source });
  const r = await startRecording();
  if (!r.ok) {
    store.set({ phase: "idle", source: null });
    toast("Запись не началась", r.error || "");
  }
}

async function endRecording() {
  if (store.phase !== "recording") return;
  const source = store.source;
  store.set({ phase: "transcribing" });
  const r = await stopRecording();
  store.set({ phase: "idle", source: null });
  if (!r.ok) {
    if (!r.quiet) toast("Не распознано", r.error || "");
    return;
  }
  if (!r.text) {
    playSound("error");
    return;
  }
  store.set({ last: r });
  log(`transcribed ${r.audio_seconds}s audio in ${r.seconds}s`);
  if (source === "hotkey") await deliver(r.text);
}

// ---------------------------------------------------------------- hotkey (push-to-talk)
// Two button sources, both normalised to button names ("L5", "R5", "A", ...):
//  1. backend hidraw reader ("hid_buttons" events): raw Deck controller reports. Works while
//     the Steam keyboard or a game owns the input, so it is preferred once it reports anything.
//  2. SteamClient.Input.RegisterForControllerInputMessages: fallback (e.g. external pads).
//     Steam stops forwarding these while its on-screen keyboard is open.
const MSG_NAMES: Record<number, string> = {
  // codes measured on a Steam Deck (SteamOS, Nov 2026)
  0: "A", 1: "B", 2: "X", 3: "Y",
  30: "L1", 31: "R1", 28: "L2", 29: "R2", 25: "L3", 41: "R3",
  44: "L4", 45: "R4", 32: "L5", 33: "R5",
  20: "↑", 21: "↓", 22: "←", 23: "→", 35: "View", 36: "Menu",
};
const NAME_ORDER = ["L4", "R4", "L5", "R5", "L1", "R1", "L2", "R2", "L3", "R3", "A", "B", "X", "Y", "View", "Menu", "↑", "↓", "←", "→"];
const NOT_FOR_COMBO = new Set(["Steam", "…"]); // handled by Steam itself

let combo: string[] | null = null;
let held = false;
let learn: { keys: Set<string>; seen: boolean; armed: boolean } | null = null;
let hidActive = false;
let pressed = new Set<string>();
const msgPressed = new Set<string>();
let unregisterMessages: (() => void) | null = null;

function loadCombo(hk: Settings["hotkey"]) {
  // older builds stored Steam message codes like "a32"
  combo = hk?.keys?.length ? hk.keys.map((k) => (/^a\d+$/.test(k) ? MSG_NAMES[+k.slice(1)] || k : k)) : null;
}

function comboText(keys: string[]) {
  const rank = (k: string) => NAME_ORDER.indexOf(k) + 1 || 999;
  return [...keys].sort((a, b) => rank(a) - rank(b)).join(" + ");
}

async function finishLearn() {
  const keys = [...learn!.keys].filter((k) => !NOT_FOR_COMBO.has(k)).sort();
  learn = null;
  store.set({ learning: false });
  log("learned keys: " + keys.join(","));
  if (keys.length < 2) {
    playSound("error");
    toast("Нужно минимум две кнопки", "Например L5 + R5, чтобы не мешать игре");
    return;
  }
  await setSetting("hotkey", { keys });
  playSound("stop");
  await refresh();
}

function onPressedChanged() {
  if (learn) {
    if (!learn.armed) {
      if (!pressed.size) learn.armed = true; // ignore the A press that opened learn mode
      return;
    }
    if (pressed.size) {
      pressed.forEach((k) => learn!.keys.add(k));
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

function onHidButtons(names: string[]) {
  if (!hidActive) {
    hidActive = true;
    log("button source: controller hidraw");
  }
  pressed = new Set(names || []);
  onPressedChanged();
}

function onInputMessages(a: any, b?: number, c?: boolean) {
  const msgs: any[] = Array.isArray(a) ? a : [{ nA: b, bS: c }];
  for (const m of msgs) {
    if (m?.nA == null) continue;
    const name = MSG_NAMES[m.nA] || "code" + m.nA;
    if (m.bS) msgPressed.add(name);
    else msgPressed.delete(name);
  }
  if (hidActive) return; // hidraw is authoritative once it works
  pressed = new Set(msgPressed);
  onPressedChanged();
}

function registerHotkey() {
  addEventListener<[string[]]>("hid_buttons", onHidButtons);
  try {
    const reg = (window as any).SteamClient?.Input?.RegisterForControllerInputMessages?.(onInputMessages);
    unregisterMessages = () => reg?.unregister?.();
  } catch (e) {
    log("RegisterForControllerInputMessages failed: " + e, "warning");
  }
}

function unregisterHotkey() {
  removeEventListener("hid_buttons", onHidButtons);
  unregisterMessages?.();
}

// ---------------------------------------------------------------- panel
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
const ENGINE_LABEL: Record<string, string> = { vulkan: "Видеокарта (Vulkan)", cpu: "Процессор" };

function fmtLeft(sec: number) {
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `${sec} с` : `${Math.ceil(sec / 60)} мин`;
}

function statusText(s: Store) {
  const st = s.state!;
  if (!st.engine_variant) return "Движок не найден — переустановите плагин";
  if (!st.models.find((m) => m.id === st.settings.model)?.installed) return "Скачайте модель ниже";
  if (!combo) return "Назначьте сочетание кнопок";
  if (s.learning) return "Отпустите A, затем зажмите кнопки";
  if (s.phase === "recording") return "Слушаю…";
  if (s.phase === "transcribing") return "Распознаю…";
  return "Готов";
}

function memoryText(st: State) {
  const srv = st.server;
  if (!srv.running) return "Не загружена — загрузится при нажатии сочетания";
  const model = st.models.find((m) => m.id === srv.model)?.label || srv.model;
  let text = `${model} · ${ENGINE_LABEL[srv.variant || ""] || srv.variant} · ОЗУ ${srv.rss_mb} МБ`;
  if (srv.gpu_mb) text += ` · видео ${srv.gpu_mb} МБ`;
  if (st.settings.keep_loaded_sec > 0 && srv.idle_sec != null) text += ` · выгрузка через ${fmtLeft(st.settings.keep_loaded_sec - srv.idle_sec)}`;
  return text;
}

function Content() {
  const s = useStore();
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000); // live memory / countdown while the panel is open
    return () => clearInterval(t);
  }, []);
  const st = s.state;
  if (!st) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <Field label="Загрузка…" />
        </PanelSectionRow>
      </PanelSection>
    );
  }
  const settings = st.settings;
  const model = st.models.find((m) => m.id === settings.model) || st.models[0];
  const dl = st.download;
  const downloading = !!dl.id && !dl.error && dl.progress > 0 && dl.progress < 1;
  const ready = !!st.engine_variant && model.installed;
  const set = async (key: string, value: unknown) => {
    await setSetting(key, value);
    refresh();
  };

  return (
    <>
      <PanelSection title="Голосовой ввод">
        <PanelSectionRow>
          <Field label="Статус" description={statusText(s)} />
        </PanelSectionRow>
        <PanelSectionRow>
          {s.phase === "recording" ? (
            <ButtonItem layout="below" onClick={() => endRecording()}>
              Остановить и распознать
            </ButtonItem>
          ) : (
            <ButtonItem layout="below" disabled={!ready || s.phase !== "idle"} onClick={() => beginRecording("panel")}>
              {s.phase === "transcribing" ? "Распознаю…" : "Записать из панели"}
            </ButtonItem>
          )}
        </PanelSectionRow>
        {s.last && (
          <PanelSectionRow>
            <Field label={`Последний текст · ${s.last.seconds} с`} description={s.last.text} />
          </PanelSectionRow>
        )}
      </PanelSection>

      <PanelSection title="Сочетание кнопок">
        <PanelSectionRow>
          <Field label="Удерживайте для записи" description={combo ? comboText(combo) : "Не назначено"} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={s.learning}
            onClick={() => {
              learn = { keys: new Set(), seen: false, armed: false };
              store.set({ learning: true });
            }}
          >
            {s.learning ? "Жду кнопки…" : combo ? "Изменить сочетание" : "Назначить сочетание"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Модель">
        <PanelSectionRow>
          <DropdownItem
            label="Модель"
            rgOptions={st.models.map((m) => ({ data: m.id, label: `${m.installed ? "✓ " : ""}${m.label}` }))}
            selectedOption={settings.model}
            onChange={(o) => set("model", o.data)}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          {model.installed ? (
            <ButtonItem
              layout="below"
              onClick={async () => {
                await deleteModel(model.id);
                refresh();
              }}
            >
              {`Удалить модель (${model.size_mb} МБ)`}
            </ButtonItem>
          ) : (
            <ButtonItem
              layout="below"
              disabled={downloading}
              onClick={async () => {
                await downloadModel(model.id);
                refresh();
              }}
            >
              {downloading && dl.id === model.id ? `Скачиваю… ${Math.round(dl.progress * 100)}%` : `Скачать модель (~${model.size_mb} МБ)`}
            </ButtonItem>
          )}
        </PanelSectionRow>
        {dl.error && (
          <PanelSectionRow>
            <Field label="Ошибка скачивания" description={dl.error} />
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <DropdownItem label="Язык" rgOptions={LANGS} selectedOption={settings.language} onChange={(o) => set("language", o.data)} />
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Движок и память">
        <PanelSectionRow>
          <Field
            label="Движок"
            description={st.engine_variant ? ENGINE_LABEL[st.engine_variant] + (st.gpu_failed ? " (видеокарта не запустилась)" : "") : "Не найден"}
          />
        </PanelSectionRow>
        {st.engines.vulkan && (
          <PanelSectionRow>
            <ToggleField label="Использовать видеокарту" description="В 5–7 раз быстрее процессора" checked={settings.gpu} onChange={(v) => set("gpu", v)} />
          </PanelSectionRow>
        )}
        <PanelSectionRow>
          <DropdownItem label="Держать модель в памяти" rgOptions={KEEP} selectedOption={settings.keep_loaded_sec} onChange={(o) => set("keep_loaded_sec", o.data)} />
        </PanelSectionRow>
        <PanelSectionRow>
          <Field label="Сейчас в памяти" description={memoryText(st)} />
        </PanelSectionRow>
        <PanelSectionRow>
          {st.server.running ? (
            <ButtonItem
              layout="below"
              disabled={s.phase !== "idle"}
              onClick={async () => {
                await unloadModel();
                refresh();
              }}
            >
              Выгрузить сейчас
            </ButtonItem>
          ) : (
            <ButtonItem
              layout="below"
              disabled={!ready}
              onClick={async () => {
                const r = await loadModel();
                if (!r.ok) toast("Модель не загрузилась", r.error || "");
                refresh();
              }}
            >
              Загрузить сейчас
            </ButtonItem>
          )}
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Дополнительно">
        <PanelSectionRow>
          <ToggleField label="Звуковые сигналы" description="Начало и конец записи" checked={settings.sounds} onChange={(v) => set("sounds", v)} />
        </PanelSectionRow>
        <PanelSectionRow>
          <ToggleField
            label="Печатать в играх (латиница)"
            description="Запасной способ, если клавиатура Steam недоступна"
            checked={settings.type_in_games}
            onChange={(v) => set("type_in_games", v)}
          />
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

// ---------------------------------------------------------------- plugin entry
function onDownloadProgress(ds: DownloadState) {
  if (store.state) store.set({ state: { ...store.state, download: ds } });
  if (ds.error) toast("Модель не скачалась", ds.error);
  if (ds.progress >= 1 || ds.error) refresh();
}

function onEngineFallback(err: string) {
  toast("Видеокарта не сработала", "Переключился на процессор: " + err);
  refresh();
}

export default definePlugin(() => {
  addEventListener<[DownloadState]>("download_progress", onDownloadProgress);
  addEventListener<[string]>("engine_fallback", onEngineFallback);
  registerHotkey();
  refresh();
  return {
    name: "Voice Input",
    titleView: <div className={staticClasses.Title}>Голосовой ввод</div>,
    content: <Content />,
    icon: <FaMicrophone />,
    onDismount() {
      removeEventListener("download_progress", onDownloadProgress);
      removeEventListener("engine_fallback", onEngineFallback);
      unregisterHotkey();
      if (store.phase === "recording") cancelRecording();
    },
  };
});
