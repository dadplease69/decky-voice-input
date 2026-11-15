import asyncio
import hashlib
import json
import math
import os
import signal
import socket
import struct
import subprocess
import time
import uuid

import decky  # provided by Decky Loader

import uinput_typer

MODELS = {
    # id: (file name, approx size MB, label)
    "base-q5_1": ("ggml-base-q5_1.bin", 60, "Base — быстрая, слабее на русском"),
    "small-q5_1": ("ggml-small-q5_1.bin", 190, "Small — баланс"),
    "medium-q5_0": ("ggml-medium-q5_0.bin", 540, "Medium — точнее"),
    "large-v3-turbo-q5_0": ("ggml-large-v3-turbo-q5_0.bin", 575, "Large v3 turbo — максимум качества"),
}
MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}"

# Prebuilt engines are published by .github/workflows/engine.yml as a GitHub release.
ENGINE_REPO = "dadplease69/decky-voice-input"
ENGINE_TAG = "engine-v1"
ENGINE_URL = "https://github.com/{repo}/releases/download/{tag}/{file}"
ENGINES = {
    # variant: (release asset name, legacy names inside plugin bin/ used during development)
    "vulkan": ("whisper-server-vulkan", ["whisper-server-vulkan"]),
    "cpu": ("whisper-server-cpu", ["whisper-server-cpu", "whisper-server"]),
}

DEFAULT_SETTINGS = {
    "model": "small-q5_1",
    "language": "ru",          # "ru", "en" or "auto"
    "hotkey": None,            # {"keys": ["a44", "a45"]} learned on device
    "type_in_games": True,     # uinput fallback (latin only)
    "delivery": "steam",       # "steam" = SteamClient.Input.ControllerKeyboardSendText
    "keep_loaded_sec": 300,    # unload after N s idle; 0 = right after each phrase, -1 = always loaded
    "threads": 8,              # Steam Deck: 4 cores / 8 threads
    "gpu": True,               # prefer the Vulkan engine when installed
    "fast_mode": False,        # shrink whisper's 30 s encoder window: faster, but repeats/reorders words
    "sounds": True,            # beep on record start/stop instead of toasts
}

SERVER_PORT = 18178
MIN_RECORD_SEC = 0.4


def clean_env():
    """Decky's PyInstaller runtime pollutes LD_LIBRARY_PATH, which breaks system binaries."""
    env = dict(os.environ)
    orig = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if orig:
        env["LD_LIBRARY_PATH"] = orig
    else:
        env.pop("LD_LIBRARY_PATH", None)
    return env


def user_ids():
    try:
        import pwd
        pw = pwd.getpwnam(decky.DECKY_USER)
        return pw.pw_uid, pw.pw_gid
    except Exception:
        return 1000, 1000


def user_session_env():
    uid, _ = user_ids()
    env = clean_env()
    env["XDG_RUNTIME_DIR"] = f"/run/user/{uid}"
    return env


def as_user_kwargs():
    if os.geteuid() != 0:
        return {}
    uid, gid = user_ids()
    return {"user": uid, "group": gid}


def make_tone_wav(path, freqs, ms_each=70, volume=0.35, rate=48000):
    """Short beep(s) with fade in/out so it doesn't click."""
    frames = bytearray()
    for f in freqs:
        n = int(rate * ms_each / 1000)
        fade = max(1, int(rate * 0.008))
        for i in range(n):
            env = min(1.0, i / fade, (n - i) / fade)
            v = int(32767 * volume * env * math.sin(2 * math.pi * f * i / rate))
            frames += struct.pack("<h", v)
    data = bytes(frames)
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data))
    with open(path, "wb") as fh:
        fh.write(header + data)


def proc_memory_mb(pid):
    """RSS plus GPU memory (amdgpu exposes drm-memory-* in /proc/<pid>/fdinfo)."""
    rss = 0
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    rss = int(line.split()[1]) // 1024
    except OSError:
        pass
    gpu = 0
    seen = set()
    try:
        for fd in os.listdir(f"/proc/{pid}/fdinfo"):
            try:
                with open(f"/proc/{pid}/fdinfo/{fd}") as f:
                    info = f.read()
            except OSError:
                continue
            if "drm-client-id" not in info:
                continue
            cid = None
            vals = 0
            for line in info.splitlines():
                if line.startswith("drm-client-id:"):
                    cid = line.split(":", 1)[1].strip()
                elif line.startswith(("drm-memory-vram:", "drm-memory-gtt:")):
                    parts = line.split()
                    num = int(parts[1])
                    unit = parts[2] if len(parts) > 2 else "KiB"
                    vals += num // 1024 if unit == "KiB" else num if unit == "MiB" else num // (1024 * 1024)
            if cid not in seen:
                seen.add(cid)
                gpu += vals
    except OSError:
        pass
    return rss, gpu


class Plugin:
    # ------------------------------------------------------------------ lifecycle
    async def _main(self):
        self.settings_path = os.path.join(decky.DECKY_PLUGIN_SETTINGS_DIR, "settings.json")
        self.models_dir = os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "models")
        self.engine_dir = os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "engine")
        self.sounds_dir = os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "sounds")
        self.shader_cache = os.path.join(decky.DECKY_PLUGIN_RUNTIME_DIR, "shader-cache")
        for d in (self.models_dir, self.engine_dir, self.sounds_dir, self.shader_cache, decky.DECKY_PLUGIN_SETTINGS_DIR):
            os.makedirs(d, exist_ok=True)
        self.settings = self._load_settings()
        self.gpu_failed = False
        self.rec_proc = None
        self.rec_path = None
        self.rec_started = 0.0
        self.server_proc = None
        self.server_key = None
        self.server_started_at = 0.0
        self.warm_task = None
        self.last_used = time.time()
        self.download_task = None
        self.download_state = {"kind": None, "id": None, "progress": 0.0, "error": None}
        self.keyboard = None
        self.busy = False
        self._fix_exec_bits()
        self._make_sounds()
        self.idle_task = asyncio.get_event_loop().create_task(self._idle_watch())
        if self.settings.get("keep_loaded_sec") == -1:
            self._preload_quietly()
        decky.logger.info("voice input started, root=%s engine=%s", os.geteuid() == 0, self._engine_variant())

    async def _unload(self):
        self._stop_recording_proc()
        self._stop_server()
        if self.keyboard:
            self.keyboard.close()
        if self.idle_task:
            self.idle_task.cancel()

    async def _uninstall(self):
        pass

    # ------------------------------------------------------------------ settings
    def _load_settings(self):
        s = dict(DEFAULT_SETTINGS)
        try:
            with open(self.settings_path) as f:
                saved = json.load(f)
            s.update({k: v for k, v in saved.items() if k in DEFAULT_SETTINGS})
            if "keep_loaded_sec" not in saved:  # migrate older minute-based settings
                mins = saved.get("keep_loaded_min", saved.get("idle_unload_min"))
                if mins is not None:
                    s["keep_loaded_sec"] = -1 if mins in (-1, None) else (0 if mins == 0 else int(mins) * 60)
            if s.get("threads") == 4:  # old default
                s["threads"] = 8
            hk = s.get("hotkey")
            if hk and not isinstance(hk.get("keys"), list):  # old bitmask format
                s["hotkey"] = None
        except FileNotFoundError:
            pass
        except Exception as e:
            decky.logger.error("settings load failed: %s", e)
        return s

    def _save_settings(self):
        tmp = self.settings_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.settings, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.settings_path)

    async def set_setting(self, key, value):
        if key not in DEFAULT_SETTINGS:
            return {"ok": False, "error": f"unknown setting {key}"}
        self.settings[key] = value
        self._save_settings()
        if key == "gpu" and value:
            self.gpu_failed = False
        if key == "keep_loaded_sec" and value == -1:
            self._preload_quietly()
        # model/language/threads/gpu changes are applied by _ensure_server() on the next use
        return {"ok": True}

    async def get_state(self):
        alive = self._server_alive()
        rss, gpu = proc_memory_mb(self.server_proc.pid) if alive else (0, 0)
        return {
            "settings": self.settings,
            "models": [
                {"id": mid, "label": m[2], "size_mb": m[1], "installed": os.path.exists(self._model_path(mid))}
                for mid, m in MODELS.items()
            ],
            "engines": {v: self._engine_path(v) is not None for v in ENGINES},
            "engine_variant": self._engine_variant(),
            "gpu_failed": self.gpu_failed,
            "server": {
                "running": alive,
                "model": self.server_key[0] if alive and self.server_key else None,
                "variant": self.server_key[3] if alive and self.server_key else None,
                "rss_mb": rss,
                "gpu_mb": gpu,
                "idle_sec": int(time.time() - self.last_used) if alive else None,
            },
            "recording": self.rec_proc is not None,
            "is_root": os.geteuid() == 0,
            "download": self.download_state,
        }

    # ------------------------------------------------------------------ sounds
    def _make_sounds(self):
        tones = {"start": [660, 990], "stop": [990, 660], "error": [330, 0, 330]}
        for name, freqs in tones.items():
            path = os.path.join(self.sounds_dir, f"{name}.wav")
            if not os.path.exists(path):
                try:
                    make_tone_wav(path, freqs)
                except OSError as e:
                    decky.logger.error("sound gen failed: %s", e)

    def _beep(self, name):
        if not self.settings.get("sounds", True):
            return
        path = os.path.join(self.sounds_dir, f"{name}.wav")
        try:
            subprocess.Popen(["pw-play", "--volume", "0.6", path], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, env=user_session_env(), start_new_session=True,
                             **as_user_kwargs())
        except Exception as e:
            decky.logger.error("beep failed: %s", e)

    async def play_sound(self, name):
        self._beep(name)
        return True

    # ------------------------------------------------------------------ downloads (models + engines)
    def _model_path(self, mid):
        return os.path.join(self.models_dir, MODELS[mid][0])

    async def _curl_download(self, url, dest, total_hint, kind, item_id):
        part = dest + ".part"
        self.download_state = {"kind": kind, "id": item_id, "progress": 0.0, "error": None}
        total = total_hint
        head = await asyncio.create_subprocess_exec(
            "curl", "-sIL", url, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=clean_env())
        out, _ = await head.communicate()
        for line in out.decode(errors="ignore").splitlines():
            if line.lower().startswith("content-length:"):
                try:
                    total = int(line.split(":")[1].strip()) or total  # last one wins (after redirects)
                except ValueError:
                    pass
        proc = await asyncio.create_subprocess_exec(
            "curl", "-sSfL", "--retry", "3", "-C", "-", "-o", part, url,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=clean_env())
        while proc.returncode is None:
            try:
                await asyncio.wait_for(proc.wait(), timeout=0.7)
            except asyncio.TimeoutError:
                pass
            size = os.path.getsize(part) if os.path.exists(part) else 0
            self.download_state["progress"] = min(size / total, 0.999) if total else 0
            await decky.emit("download_progress", self.download_state)
        if proc.returncode != 0:
            err = (await proc.stderr.read()).decode(errors="ignore").strip()
            raise RuntimeError(err or f"curl exit {proc.returncode}")
        return part

    def _start_download(self, coro):
        if self.download_task and not self.download_task.done():
            return {"ok": False, "error": "уже идёт скачивание"}
        self.download_task = asyncio.get_event_loop().create_task(coro)
        return {"ok": True}

    async def download_model(self, mid):
        if mid not in MODELS:
            return {"ok": False, "error": "unknown model"}
        return self._start_download(self._download_model(mid))

    async def _download_model(self, mid):
        try:
            dest = self._model_path(mid)
            part = await self._curl_download(MODEL_URL.format(file=MODELS[mid][0]), dest,
                                             MODELS[mid][1] * 1024 * 1024, "model", mid)
            os.replace(part, dest)
            self.download_state = {"kind": "model", "id": mid, "progress": 1.0, "error": None}
        except Exception as e:
            decky.logger.error("model download failed: %s", e)
            self.download_state = {"kind": "model", "id": mid, "progress": 0.0, "error": str(e)}
        await decky.emit("download_progress", self.download_state)

    async def delete_model(self, mid):
        if self.server_key and self.server_key[0] == mid:
            self._stop_server()
        try:
            os.remove(self._model_path(mid))
        except FileNotFoundError:
            pass
        return {"ok": True}

    async def download_engine(self, variant):
        if variant not in ENGINES:
            return {"ok": False, "error": "unknown engine"}
        return self._start_download(self._download_engine(variant))

    async def _download_engine(self, variant):
        asset = ENGINES[variant][0]
        try:
            sums_url = ENGINE_URL.format(repo=ENGINE_REPO, tag=ENGINE_TAG, file="SHA256SUMS")
            p = await asyncio.create_subprocess_exec("curl", "-sSfL", sums_url, stdout=subprocess.PIPE,
                                                     stderr=subprocess.PIPE, env=clean_env())
            out, err = await p.communicate()
            if p.returncode != 0:
                raise RuntimeError("нет релиза движка " + ENGINE_TAG + ": " + err.decode(errors="ignore").strip())
            expected = None
            for line in out.decode().splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[1].lstrip("*") == asset:
                    expected = parts[0].lower()
            if not expected:
                raise RuntimeError(f"{asset} нет в SHA256SUMS")
            dest = os.path.join(self.engine_dir, asset)
            part = await self._curl_download(ENGINE_URL.format(repo=ENGINE_REPO, tag=ENGINE_TAG, file=asset),
                                             dest, 40 * 1024 * 1024, "engine", variant)
            h = hashlib.sha256()
            with open(part, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            if h.hexdigest() != expected:
                os.remove(part)
                raise RuntimeError("контрольная сумма не совпала, файл удалён")
            os.chmod(part, 0o755)
            os.replace(part, dest)
            if variant == "vulkan":
                self.gpu_failed = False
            self.download_state = {"kind": "engine", "id": variant, "progress": 1.0, "error": None}
        except Exception as e:
            decky.logger.error("engine download failed: %s", e)
            self.download_state = {"kind": "engine", "id": variant, "progress": 0.0, "error": str(e)}
        await decky.emit("download_progress", self.download_state)

    async def delete_engine(self, variant):
        if self.server_key and self.server_key[3] == variant:
            self._stop_server()
        try:
            os.remove(os.path.join(self.engine_dir, ENGINES[variant][0]))
        except (KeyError, FileNotFoundError):
            pass
        return {"ok": True}

    # ------------------------------------------------------------------ engine selection
    def _engine_path(self, variant):
        asset, legacy = ENGINES[variant]
        candidates = [os.path.join(self.engine_dir, asset)]
        candidates += [os.path.join(decky.DECKY_PLUGIN_DIR, "bin", n) for n in legacy]
        for c in candidates:
            if os.path.isfile(c) and os.access(c, os.X_OK):
                return c
        return None

    def _fix_exec_bits(self):
        # Decky unpacks store zips with ZipFile.extractall, which drops the executable bit
        for variant in ENGINES:
            asset, legacy = ENGINES[variant]
            for c in [os.path.join(self.engine_dir, asset)] + [os.path.join(decky.DECKY_PLUGIN_DIR, "bin", n) for n in legacy]:
                if os.path.isfile(c) and not os.access(c, os.X_OK):
                    try:
                        os.chmod(c, 0o755)
                    except OSError as e:
                        decky.logger.error("chmod %s failed: %s", c, e)

    def _engine_variant(self):
        if self.settings.get("gpu") and not self.gpu_failed and self._engine_path("vulkan"):
            return "vulkan"
        if self._engine_path("cpu"):
            return "cpu"
        if self._engine_path("vulkan") and not self.gpu_failed:
            return "vulkan"
        return None

    # ------------------------------------------------------------------ whisper-server lifecycle
    def _server_alive(self):
        return self.server_proc is not None and self.server_proc.poll() is None

    def _ensure_server(self):
        """Start whisper-server if needed (non-blocking). Called at record start so model
        loading overlaps with the user speaking."""
        variant = self._engine_variant()
        key = (self.settings["model"], self.settings["language"], self.settings["threads"], variant)
        if self._server_alive() and self.server_key == key:
            return False
        self._stop_server()
        if not variant:
            raise RuntimeError("Движок не установлен — установите его в панели плагина")
        model = self._model_path(self.settings["model"])
        if not os.path.exists(model):
            raise RuntimeError("Модель не скачана")
        engine = self._engine_path(variant)
        env = clean_env()
        env["MESA_SHADER_CACHE_DIR"] = self.shader_cache  # keep compiled Vulkan shaders between starts
        env["MESA_SHADER_CACHE_MAX_SIZE"] = "512M"
        log = open(os.path.join(decky.DECKY_PLUGIN_LOG_DIR, "whisper-server.log"), "ab")
        cmd = [engine, "-m", model, "-l", self.settings["language"], "-t", str(self.settings["threads"]),
               "--host", "127.0.0.1", "--port", str(SERVER_PORT)]
        self.server_proc = subprocess.Popen(cmd, stdout=log, stderr=log, env=env, start_new_session=True)
        self.server_key = key
        self.server_started_at = time.time()
        self.last_used = time.time()
        decky.logger.info("whisper-server started pid=%s variant=%s key=%s", self.server_proc.pid, variant, key)
        # First inference on a fresh server is slow (GPU pipelines, caches) — warm it up in the background
        self.warm_task = asyncio.get_event_loop().create_task(self._warm_up())
        return True

    def _stop_server(self):
        if self.warm_task and not self.warm_task.done():
            self.warm_task.cancel()
        if self._server_alive():
            try:
                os.killpg(self.server_proc.pid, signal.SIGTERM)
                self.server_proc.wait(timeout=3)
            except Exception:
                try:
                    os.killpg(self.server_proc.pid, signal.SIGKILL)
                except Exception:
                    pass
            decky.logger.info("whisper-server stopped")
        self.server_proc = None
        self.server_key = None

    async def _wait_server_ready(self, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self._server_alive():
                raise RuntimeError("whisper-server упал при запуске, см. whisper-server.log")
            try:
                with socket.create_connection(("127.0.0.1", SERVER_PORT), timeout=0.3):
                    return
            except OSError:
                await asyncio.sleep(0.1)
        raise RuntimeError("whisper-server не запустился за отведённое время")

    async def _warm_up(self):
        try:
            await self._wait_server_ready()
            t0 = time.time()
            silence = b"RIFF" + struct.pack("<I", 36 + 32000) + b"WAVEfmt " + struct.pack(
                "<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16) + b"data" + struct.pack("<I", 32000) + b"\x00" * 32000
            await asyncio.get_event_loop().run_in_executor(None, self._post_inference_bytes, silence, False)
            decky.logger.info("warm-up %.2fs (load+warm %.2fs)", time.time() - t0, time.time() - self.server_started_at)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            decky.logger.info("warm-up skipped: %s", e)

    def _preload_quietly(self):
        try:
            self._ensure_server()
        except Exception as e:
            decky.logger.info("preload skipped: %s", e)

    async def load_model(self):
        try:
            self._ensure_server()
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def unload_model(self):
        self._stop_server()
        return {"ok": True}

    async def _idle_watch(self):
        while True:
            await asyncio.sleep(2)
            secs = self.settings.get("keep_loaded_sec", 300)
            if secs is None or secs <= 0:
                continue  # -1 = always loaded; 0 = handled right after each phrase
            if self._server_alive() and not self.busy and self.rec_proc is None \
                    and (self.warm_task is None or self.warm_task.done()) \
                    and time.time() - self.last_used > secs:
                decky.logger.info("unloading idle whisper-server after %ss", secs)
                self._stop_server()

    # ------------------------------------------------------------------ inference
    @staticmethod
    def _multipart(fields, file_field, file_name, file_bytes):
        boundary = uuid.uuid4().hex
        parts = []
        for k, v in fields.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{file_name}"\r\n'
            f"Content-Type: audio/wav\r\n\r\n".encode() + file_bytes + b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        return boundary, b"".join(parts)

    @staticmethod
    def audio_ctx_for(seconds):
        """Encoder context (1 unit = 20 ms, full = 1500 = 30 s), rounded up to 64, with margin."""
        units = int(seconds * 50) + 128
        units = ((units + 63) // 64) * 64
        return max(384, min(1500, units))

    def _post_inference_bytes(self, data, allow_fast=True):
        import http.client
        fields = {"response_format": "json", "temperature": "0.0", "no_timestamps": "true"}
        if allow_fast and self.settings.get("fast_mode"):
            seconds = max(0, len(data) - 44) / 32000.0  # 16 kHz mono s16
            fields["audio_ctx"] = str(self.audio_ctx_for(seconds))
        boundary, body = self._multipart(fields, "file", "audio.wav", data)
        conn = http.client.HTTPConnection("127.0.0.1", SERVER_PORT, timeout=120)
        conn.request("POST", "/inference", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8", errors="replace")
        conn.close()
        if resp.status != 200:
            raise RuntimeError(f"whisper-server HTTP {resp.status}: {raw[:200]}")
        return json.loads(raw).get("text", "")

    # ------------------------------------------------------------------ recording
    def _stop_recording_proc(self):
        if self.rec_proc is not None:
            try:
                os.killpg(self.rec_proc.pid, signal.SIGINT)  # pw-record finalizes the WAV header on SIGINT
                self.rec_proc.wait(timeout=3)
            except Exception:
                try:
                    os.killpg(self.rec_proc.pid, signal.SIGKILL)
                except Exception:
                    pass
            self.rec_proc = None

    async def start_recording(self):
        if self.rec_proc is not None or self.busy:
            return {"ok": False, "error": "уже идёт запись или распознавание"}
        try:
            self._ensure_server()
        except Exception as e:
            self._beep("error")
            return {"ok": False, "error": str(e)}
        self._beep("start")
        self.rec_path = f"/tmp/decky-voice-{uuid.uuid4().hex[:8]}.wav"
        try:
            self.rec_proc = subprocess.Popen(
                ["pw-record", "--rate", "16000", "--channels", "1", "--format", "s16", self.rec_path],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=user_session_env(),
                start_new_session=True, **as_user_kwargs())
        except Exception as e:
            self.rec_proc = None
            self._beep("error")
            return {"ok": False, "error": f"не удалось запустить pw-record: {e}"}
        self.rec_started = time.time()
        self.last_used = time.time()
        return {"ok": True}

    async def cancel_recording(self):
        self._stop_recording_proc()
        if self.rec_path and os.path.exists(self.rec_path):
            os.remove(self.rec_path)
        return {"ok": True}

    async def stop_recording(self):
        if self.rec_proc is None:
            return {"ok": False, "error": "запись не идёт"}
        duration = time.time() - self.rec_started
        proc = self.rec_proc
        self._stop_recording_proc()
        self._beep("stop")
        if proc.stderr:
            err = proc.stderr.read().decode(errors="ignore").strip()
            if err:
                decky.logger.info("pw-record: %s", err)
        path = self.rec_path
        if duration < MIN_RECORD_SEC or not os.path.exists(path) or os.path.getsize(path) < 2000:
            return {"ok": False, "error": "слишком короткая запись", "quiet": True}
        self.busy = True
        t0 = time.time()
        try:
            try:
                await self._wait_server_ready()
            except RuntimeError as e:
                if self.server_key and self.server_key[3] != "vulkan":
                    raise
                decky.logger.error("GPU engine failed (%s), falling back to CPU", e)
                self.gpu_failed = True
                await decky.emit("engine_fallback", str(e))
                self._ensure_server()
                await self._wait_server_ready()
            if self.warm_task and not self.warm_task.done():
                await asyncio.wait([self.warm_task], timeout=10)
            with open(path, "rb") as f:
                data = f.read()
            text = await asyncio.get_event_loop().run_in_executor(None, self._post_inference_bytes, data, True)
            text = " ".join(text.split())  # whisper adds leading spaces / newlines
            decky.logger.info("inference %.2fs for %.1fs audio, variant=%s threads=%s fast_mode=%s",
                              time.time() - t0, duration, self.server_key[3] if self.server_key else "?",
                              self.settings["threads"], self.settings.get("fast_mode"))
            self.last_used = time.time()
            return {"ok": True, "text": text, "seconds": round(time.time() - t0, 2),
                    "audio_seconds": round(duration, 1)}
        except Exception as e:
            decky.logger.error("transcription failed: %s", e)
            self._beep("error")
            return {"ok": False, "error": str(e)}
        finally:
            self.busy = False
            try:
                os.remove(path)
            except OSError:
                pass
            if self.settings.get("keep_loaded_sec") == 0:
                self._stop_server()

    # ------------------------------------------------------------------ typing into games
    async def type_text(self, text):
        if os.geteuid() != 0:
            return {"ok": False, "error": "нужен root для виртуальной клавиатуры"}
        bad = uinput_typer.untypeable_chars(text)
        if bad:
            return {"ok": False, "error": "non_ascii", "chars": "".join(bad[:10])}
        try:
            if self.keyboard is None:
                self.keyboard = uinput_typer.VirtualKeyboard()
            await asyncio.get_event_loop().run_in_executor(None, self.keyboard.type_text, text)
            return {"ok": True}
        except Exception as e:
            decky.logger.error("uinput typing failed: %s", e)
            return {"ok": False, "error": str(e)}

    async def log(self, level, msg):
        getattr(decky.logger, level if level in ("info", "warning", "error") else "info")("[ui] %s", msg)
        return True
