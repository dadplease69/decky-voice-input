"""Minimal virtual keyboard over /dev/uinput, pure Python (no python-evdev).

Types ASCII text using US key codes. Non-ASCII characters (e.g. Cyrillic)
cannot be expressed as raw key codes without knowing the target layout,
so they are reported back to the caller instead of being typed wrongly.
"""
import fcntl
import os
import struct
import time

EV_SYN = 0x00
EV_KEY = 0x01
SYN_REPORT = 0

UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

BUS_VIRTUAL = 0x06
KEY_LEFTSHIFT = 42
KEY_ENTER = 28
KEY_SPACE = 57
KEY_TAB = 15

# input_event on 64-bit Linux: struct timeval (2 x long) + u16 type + u16 code + s32 value
_EVENT = struct.Struct("llHHi")

_LETTERS = {
    "q": 16, "w": 17, "e": 18, "r": 19, "t": 20, "y": 21, "u": 22, "i": 23, "o": 24, "p": 25,
    "a": 30, "s": 31, "d": 32, "f": 33, "g": 34, "h": 35, "j": 36, "k": 37, "l": 38,
    "z": 44, "x": 45, "c": 46, "v": 47, "b": 48, "n": 49, "m": 50,
}
_PLAIN = {
    "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
    "-": 12, "=": 13, "[": 26, "]": 27, ";": 39, "'": 40, "`": 41, "\\": 43,
    ",": 51, ".": 52, "/": 53, " ": KEY_SPACE, "\n": KEY_ENTER, "\t": KEY_TAB,
}
_SHIFTED = {
    "!": 2, "@": 3, "#": 4, "$": 5, "%": 6, "^": 7, "&": 8, "*": 9, "(": 10, ")": 11,
    "_": 12, "+": 13, "{": 26, "}": 27, ":": 39, '"': 40, "~": 41, "|": 43,
    "<": 51, ">": 52, "?": 53,
}
# Typographic characters Whisper likes to produce -> ASCII equivalents
_NORMALIZE = {
    "’": "'", "‘": "'", "“": '"', "”": '"', "«": '"', "»": '"',
    "–": "-", "—": "-", "…": "...", " ": " ",
}


def char_to_key(ch):
    """Return (keycode, needs_shift) or None if the char can't be typed."""
    if ch in _PLAIN:
        return _PLAIN[ch], False
    if ch in _SHIFTED:
        return _SHIFTED[ch], True
    low = ch.lower()
    if low in _LETTERS and ch.isascii():
        return _LETTERS[low], ch.isupper()
    return None


def normalize(text):
    return "".join(_NORMALIZE.get(c, c) for c in text)


def untypeable_chars(text):
    return sorted({c for c in normalize(text) if char_to_key(c) is None})


class VirtualKeyboard:
    def __init__(self, name=b"decky-voice-input"):
        self.fd = None
        self.name = name

    def open(self):
        if self.fd is not None:
            return
        fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
        fcntl.ioctl(fd, UI_SET_EVBIT, EV_SYN)
        for code in set(_LETTERS.values()) | set(_PLAIN.values()) | set(_SHIFTED.values()) | {KEY_LEFTSHIFT}:
            fcntl.ioctl(fd, UI_SET_KEYBIT, code)
        # legacy struct uinput_user_dev: name[80], input_id(4 x u16), ff_effects_max(u32), 4 x s32[64]
        dev = struct.pack("80sHHHHi", self.name, BUS_VIRTUAL, 0x1209, 0x5643, 1, 0) + b"\x00" * (4 * 64 * 4)
        os.write(fd, dev)
        fcntl.ioctl(fd, UI_DEV_CREATE)
        self.fd = fd
        # Give the compositor (gamescope) time to pick up the new device
        time.sleep(0.6)

    def close(self):
        if self.fd is not None:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY)
            finally:
                os.close(self.fd)
                self.fd = None

    def _emit(self, etype, code, value):
        os.write(self.fd, _EVENT.pack(0, 0, etype, code, value))

    def _syn(self):
        self._emit(EV_SYN, SYN_REPORT, 0)

    def _tap(self, code, shift, delay):
        if shift:
            self._emit(EV_KEY, KEY_LEFTSHIFT, 1)
            self._syn()
        self._emit(EV_KEY, code, 1)
        self._syn()
        time.sleep(delay)
        self._emit(EV_KEY, code, 0)
        self._syn()
        if shift:
            self._emit(EV_KEY, KEY_LEFTSHIFT, 0)
            self._syn()
        time.sleep(delay)

    def type_text(self, text, delay=0.012):
        """Type text. Returns the number of skipped (untypeable) characters."""
        self.open()
        skipped = 0
        for ch in normalize(text):
            key = char_to_key(ch)
            if key is None:
                skipped += 1
                continue
            self._tap(key[0], key[1], delay)
        return skipped
