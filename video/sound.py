"""The demo video's sound, synthesized from code: a music bed plus effects
timed to the motion, read from src/timeline.json. Levelled to -14 LUFS
(the usual loudness for social video) with pyloudnorm.

    python3 sound.py        # writes public/audio/score.wav

Needs numpy, scipy and pyloudnorm.
"""

import json
import warnings
from pathlib import Path

import numpy as np
import pyloudnorm as pyln
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

SR = 48_000
HERE = Path(__file__).parent
TL = json.loads((HERE / "src/timeline.json").read_text())
FPS, T = TL["fps"], TL["transition"]

# Where each scene starts, in seconds: scenes overlap by one transition.
starts, at = {}, 0
for sc in TL["scenes"]:
    starts[sc["id"]] = at / FPS
    at += sc["frames"] - T
DUR = (at + T) / FPS + 0.5
N = int(DUR * SR)
t = np.arange(N) / SR
rng = np.random.default_rng(7)
warnings.filterwarnings("ignore", message="Possible clipped samples")  # the limiter below handles peaks


def note(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def env(n: int, attack: float, release: float) -> np.ndarray:
    a = min(n, int(attack * SR))
    e = np.ones(n)
    if a:
        e[:a] = np.linspace(0, 1, a)
    return e * np.exp(-np.arange(n) / (release * SR))


def lowpass(x: np.ndarray, hz: float) -> np.ndarray:
    return sosfilt(butter(2, hz, "low", fs=SR, output="sos"), x)


def highpass(x: np.ndarray, hz: float) -> np.ndarray:
    return sosfilt(butter(2, hz, "high", fs=SR, output="sos"), x)


def add(buf: np.ndarray, sig: np.ndarray, start: float, gain: float = 1.0):
    i = int(start * SR)
    if i >= len(buf) or i < 0:
        return
    sig = sig[: len(buf) - i]
    buf[i : i + len(sig)] += sig * gain


music = np.zeros(N)
fx = np.zeros(N)

# ------------------------------------------------------------------ music
# A minor, F, C, G at 96 BPM, one chord a bar. The problem stays dark (pad
# only); a plucked arpeggio and a soft pulse come in when Keel arrives.
BPM = 96
beat = 60 / BPM
bar = 4 * beat
CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]
turn = starts["turn"]

for b in range(int(DUR / bar) + 1):
    chord = CHORDS[b % 4]
    s0 = b * bar
    n = int((bar + 0.6) * SR)
    tt = np.arange(n) / SR
    pad = sum(np.sin(2 * np.pi * note(m) * tt) + 0.5 * np.sin(2 * np.pi * note(m) * 1.003 * tt) for m in chord)
    pad = pad + 0.6 * np.sin(2 * np.pi * note(chord[0] - 12) * tt)
    e = np.minimum(1, tt / 0.8) * np.minimum(1, np.maximum(0, (bar + 0.6 - tt) / 0.8))
    add(music, lowpass(pad * e, 1400), s0, 0.05)

    if s0 >= turn - 0.2:
        for k in range(8):
            m = chord[k % 3] + (12 if k % 4 == 3 else 0) + 12
            n2 = int(0.5 * SR)
            tt2 = np.arange(n2) / SR
            pluck = (np.sin(2 * np.pi * note(m) * tt2) + 0.3 * np.sin(4 * np.pi * note(m) * tt2)) * env(n2, 0.004, 0.18)
            add(music, pluck, s0 + k * beat / 2, 0.035)
        for k in range(4):
            n3 = int(0.35 * SR)
            tt3 = np.arange(n3) / SR
            f = 70 * np.exp(-tt3 * 18) + 45
            kick = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n3, 0.002, 0.09)
            add(music, kick, s0 + k * beat, 0.16)

music *= np.clip((DUR - 0.5 - t) / 2.0, 0, 1)  # fade out over the last two seconds

# --------------------------------------------------------------------- fx


def whoosh(length: float = 0.55) -> np.ndarray:
    n = int(length * SR)
    return highpass(lowpass(rng.standard_normal(n), 3500), 300) * np.sin(np.linspace(0, np.pi, n)) ** 2


def chime(midi: int, length: float = 1.2) -> np.ndarray:
    n = int(length * SR)
    tt = np.arange(n) / SR
    tone = np.sin(2 * np.pi * note(midi) * tt) + 0.4 * np.sin(2 * np.pi * note(midi + 7) * tt) + 0.2 * np.sin(2 * np.pi * note(midi + 12) * tt)
    return tone * env(n, 0.005, 0.35)


def thud(length: float = 0.6) -> np.ndarray:
    n = int(length * SR)
    tt = np.arange(n) / SR
    body = np.sin(2 * np.pi * np.cumsum(120 * np.exp(-tt * 14) + 38) / SR) * env(n, 0.002, 0.16)
    return body + 0.4 * lowpass(rng.standard_normal(n), 900) * env(n, 0.001, 0.02)


def impact(length: float = 2.4) -> np.ndarray:
    n = int(length * SR)
    tt = np.arange(n) / SR
    boom = np.sin(2 * np.pi * np.cumsum(55 * np.exp(-tt * 3) + 30) / SR) * env(n, 0.003, 0.7)
    return boom + highpass(rng.standard_normal(n), 4000) * env(n, 0.01, 0.5) * 0.15


def tick() -> np.ndarray:
    n = int(0.05 * SR)
    return highpass(rng.standard_normal(n), 2500) * env(n, 0.0005, 0.008)


def sweep_down(length: float = 1.6) -> np.ndarray:
    n = int(length * SR)
    tt = np.arange(n) / SR
    return np.sin(2 * np.pi * np.cumsum(880 * np.exp(-tt * 1.6) + 60) / SR) * np.minimum(1, tt / 0.05) * np.exp(-tt * 1.2)


def at_frame(scene: str, frame: int) -> float:
    return starts[scene] + frame / FPS


for sc in TL["scenes"][1:]:
    add(fx, whoosh(), starts[sc["id"]] - 0.1, 0.22)

for i in range(5):  # the chain balances pop in
    add(fx, tick(), at_frame("chains", 34 + i * 6), 0.5)
add(fx, sweep_down(), at_frame("key", 92), 0.13)  # the wallet drains
add(fx, impact(), at_frame("turn", 40), 0.5)  # KEEL
add(fx, chime(76), at_frame("line", 90), 0.12)  # paid alone
add(fx, chime(69), at_frame("line", 178), 0.12)  # waits for you
add(fx, thud(), at_frame("line", 220), 0.55)  # refused at the line
for i in range(6):  # terminal lines type in
    for k in range(5):
        add(fx, tick(), at_frame("proof", 30 + i * 22 + k * 3), 0.18)
add(fx, chime(81, 0.8), at_frame("team", 80), 0.1)  # votes land
add(fx, chime(84, 0.8), at_frame("team", 100), 0.1)
add(fx, chime(88, 1.0), at_frame("alerts", 20), 0.12)  # the email arrives
add(fx, impact(3.0), at_frame("cta", 0), 0.35)

mix = music + fx
mix = np.stack([mix, np.roll(mix, int(0.011 * SR)) * 0.96], axis=1)  # a little stereo width



def limit(x: np.ndarray, ceiling: float = 0.89, release: float = 0.08) -> np.ndarray:
    """A peak limiter: gain drops instantly at a peak and recovers over `release` seconds."""
    level = np.max(np.abs(x), axis=1)
    want = np.minimum(1.0, ceiling / np.maximum(level, 1e-9))
    k = np.exp(-1 / (release * SR))
    gain = np.empty_like(want)
    g = 1.0
    for i, w in enumerate(want):  # ~3M samples: fine for a one-off render
        g = w if w < g else k * g + (1 - k) * w
        gain[i] = g
    return x * gain[:, None]


meter = pyln.Meter(SR)
for _ in range(3):  # bring it up to -14 LUFS, then hold the peaks under -1 dBFS
    mix = pyln.normalize.loudness(mix, meter.integrated_loudness(mix), -14.0)
    mix = limit(mix)
mix = np.clip(mix, -0.891, 0.891)
out = HERE / "public/audio/score.wav"
out.parent.mkdir(parents=True, exist_ok=True)
wavfile.write(out, SR, (mix * 32767).astype(np.int16))
print(f"{out.name}: {DUR:.1f} s, {meter.integrated_loudness(mix):.1f} LUFS, peak {20 * np.log10(np.max(np.abs(mix))):.1f} dBFS")
