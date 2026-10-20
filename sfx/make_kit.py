# The sound-effect kit, synthesized with numpy (no samples, no downloads), so the sounds are
# ours and live in the public repo. Every file is 48 kHz mono 16-bit and calibrated so its
# loudest 400 ms (EBU R128 momentary loudness, K-weighted) sits at LEVEL + its trim: LEVEL is
# 11 dB under a -16 LUFS voice, the SFX level from video-lab 001. build_soundtrack mixes a
# cue at the file's own level plus the cue's gain, so a kit sound with gain 0 lands where the
# lab put its effects.
#
#   python3 sfx/make_kit.py            writes sfx/<name>.wav and prints each sound's level
#
# Started from video-lab 001's sfx.py (filtered-noise whoosh, round pop, paper). The seed is
# fixed, so running it again gives the same files.
import os, sys, wave
import numpy as np

SR = 48000
LEVEL = -27.0  # LUFS momentary max: -16 LUFS speech minus 11 dB
OUT = os.path.dirname(os.path.abspath(__file__))
rng = np.random.default_rng(20261020)


def t_of(dur):
    return np.arange(int(SR * dur)) / SR


def biquad(x, b, a):
    y = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    b0, b1, b2 = b
    _, a1, a2 = a
    for i in range(len(x)):
        v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1, y2, y1 = x1, x[i], y1, v
        y[i] = v
    return y


def svf_band(x, fc, q=0.9):
    # State-variable band-pass with a cutoff that may move per sample: the sweep in a whoosh.
    fc = np.broadcast_to(np.asarray(fc, dtype=float), x.shape)
    low = band = 0.0
    out = np.zeros_like(x)
    damp = 1.0 / q
    for i in range(len(x)):
        f = 2 * np.sin(np.pi * min(fc[i], SR / 6) / SR)
        high = x[i] - low - damp * band
        band += f * high
        low += f * band
        out[i] = band
    return out


def lowpass(x, fc):
    w = 2 * np.pi * fc / SR
    alpha = np.sin(w) / (2 * 0.707)
    c = np.cos(w)
    a0 = 1 + alpha
    return biquad(x, [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0], [1, -2 * c / a0, (1 - alpha) / a0])


def highpass(x, fc):
    w = 2 * np.pi * fc / SR
    alpha = np.sin(w) / (2 * 0.707)
    c = np.cos(w)
    a0 = 1 + alpha
    return biquad(x, [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0], [1, -2 * c / a0, (1 - alpha) / a0])


def fade(x, a=0.004, r=0.02):
    # A few ms of fade at both ends, so nothing clicks where it starts or stops.
    n = len(x)
    ia, ir = min(n, int(SR * a)), min(n, int(SR * r))
    x = x.copy()
    if ia:
        x[:ia] *= np.linspace(0, 1, ia)
    if ir:
        x[n - ir:] *= np.linspace(1, 0, ir)
    return x


def env_arc(n, power=2.0, peak=0.5):
    # Rises to its peak at `peak` of the length, then falls: an airy swell.
    u = np.linspace(0, 1, n)
    up = np.clip(u / peak, 0, 1)
    down = np.clip((1 - u) / (1 - peak), 0, 1)
    return (np.sin(np.minimum(up, down) * np.pi / 2)) ** power


def whoosh(dur=0.45, lo=350, hi=2400, peak=0.55):
    t = t_of(dur)
    u = t / dur
    fc = lo * (hi / lo) ** np.sin(u * np.pi)  # up and back down
    x = svf_band(rng.standard_normal(len(t)), fc, q=1.4)
    x = lowpass(x, 6000)
    return fade(x * env_arc(len(t), 2.2, peak))


def swoosh(dur=0.6):
    # A 3D move: noise and a faint tone gliding up, louder as it passes.
    t = t_of(dur)
    u = t / dur
    fc = 260 * (3600 / 260) ** (u ** 1.3)
    x = svf_band(rng.standard_normal(len(t)), fc, q=2.2)
    phase = 2 * np.pi * np.cumsum(180 * (6 ** u)) / SR
    x = x + 0.08 * np.sin(phase)
    return fade(lowpass(x, 7000) * env_arc(len(t), 1.8, 0.62))


def pop(freq=520, dur=0.16):
    t = t_of(dur)
    phase = 2 * np.pi * freq * (t + 0.25 * (1 - np.exp(-t * 40)) / 40)
    x = np.sin(phase) * np.exp(-t * 26) + 0.15 * np.sin(2 * phase) * np.exp(-t * 60)
    return fade(x, 0.0015, 0.01)


def tick():
    t = t_of(0.05)
    x = np.sin(2 * np.pi * 3200 * t) * np.exp(-t * 260) + 0.3 * highpass(rng.standard_normal(len(t)), 4000) * np.exp(-t * 500)
    return fade(x, 0.0005, 0.005)


def click():
    # A soft mouse click: press and release 45 ms apart.
    def one(f, d):
        t = t_of(0.03)
        return (0.7 * np.sin(2 * np.pi * f * t) + 0.5 * svf_band(rng.standard_normal(len(t)), 2200, 2)) * np.exp(-t * d)
    x = np.zeros(int(SR * 0.09))
    a, b = one(1700, 340), one(2100, 420) * 0.6
    x[: len(a)] += a
    x[int(SR * 0.045): int(SR * 0.045) + len(b)] += b
    return fade(x, 0.0005, 0.01)


def key_tap(heavy=False):
    t = t_of(0.045 if not heavy else 0.07)
    f = rng.uniform(1300, 2300) if not heavy else rng.uniform(700, 900)
    body = svf_band(rng.standard_normal(len(t)), f, q=3) * np.exp(-t * (180 if not heavy else 110))
    knock = np.sin(2 * np.pi * (f / 4) * t) * np.exp(-t * 300) * 0.4
    return (body + knock) * rng.uniform(0.6, 1.0)


def typing(dur=1.5):
    # Soft keys at a typing pace, a heavier space bar now and then.
    x = np.zeros(int(SR * dur))
    at = 0.02
    while at < dur - 0.08:
        heavy = rng.random() < 0.14
        k = key_tap(heavy)
        i = int(at * SR)
        x[i: i + len(k)] += k[: len(x) - i]
        at += rng.uniform(0.07, 0.15) + (0.08 if heavy else 0)
    return fade(lowpass(x, 7000), 0.002, 0.04)


def ding():
    # Success: two soft bell notes, a fifth apart.
    out = np.zeros(int(SR * 1.1))
    for start, f, g in [(0.0, 1046.5, 0.8), (0.11, 1568.0, 1.0)]:
        t = t_of(1.1 - start)
        bell = sum(a * np.sin(2 * np.pi * f * m * t) * np.exp(-t * d) for m, a, d in [(1, 1, 4.5), (2.01, 0.25, 8), (3.02, 0.08, 14)])
        i = int(start * SR)
        out[i: i + len(t)] += g * bell * (1 - np.exp(-t * 900))
    return fade(out, 0.001, 0.08)


def error():
    # A soft "no": two short low tones stepping down, rounded off.
    out = np.zeros(int(SR * 0.42))
    for start, f in [(0.0, 220), (0.17, 175)]:
        t = t_of(0.2)
        tone = np.tanh(1.8 * np.sin(2 * np.pi * f * t)) + 0.3 * np.sin(2 * np.pi * f * 2.01 * t)
        tone = lowpass(tone, 1400) * np.minimum(1, t / 0.008) * np.exp(-t * 9)
        i = int(start * SR)
        out[i: i + len(t)] += tone
    return fade(out, 0.002, 0.03)


def riser(dur=1.2):
    # Builds for 1.2 s and stops: anchor it 1.2 s before the word it leads into.
    t = t_of(dur)
    u = t / dur
    fc = 300 * (5000 / 300) ** (u ** 1.6)
    noise = svf_band(rng.standard_normal(len(t)), fc, q=1.6)
    phase = 2 * np.pi * np.cumsum(140 * (4 ** (u ** 1.4))) / SR
    tone = 0.12 * (np.sin(phase) + 0.5 * np.sin(1.5 * phase))
    return fade((noise + tone) * u ** 2.2, 0.01, 0.04)


def thud():
    t = t_of(0.4)
    phase = 2 * np.pi * (52 * t + 70 * (1 - np.exp(-t * 30)) / 30)
    x = np.sin(phase) * np.exp(-t * 11) + 0.25 * lowpass(rng.standard_normal(len(t)), 500) * np.exp(-t * 40)
    return fade(x, 0.001, 0.04)


def paper(dur=0.6):
    # Paper handed over: high noise with a rough, uneven edge.
    t = t_of(dur)
    x = svf_band(rng.standard_normal(len(t)), np.full(len(t), 4200.0), q=0.8)
    grain = np.repeat(rng.uniform(0.35, 1.0, int(dur * 120) + 1), SR // 120)[: len(t)]
    return fade(lowpass(highpass(x, 1200), 9000) * grain * env_arc(len(t), 1.4, 0.35), 0.003, 0.05)


def glitch(dur=0.38):
    # Short digital stutter: slices of square and noise at jumping pitches, bit-crushed.
    out = np.zeros(int(SR * dur))
    at = 0.0
    while at < dur - 0.02:
        n = int(SR * rng.uniform(0.018, 0.05))
        t = t_of(n / SR)
        if rng.random() < 0.6:
            s = np.sign(np.sin(2 * np.pi * rng.uniform(300, 1600) * t)) * 0.5
        else:
            s = rng.standard_normal(n) * 0.5
        s = np.round(s * 6) / 6
        i = int(at * SR)
        out[i: i + n] += s[: len(out) - i] * rng.uniform(0.4, 1.0)
        at += n / SR + rng.uniform(0, 0.012)
    return fade(lowpass(out, 6000), 0.001, 0.03)


# name -> (sound, trim in dB against LEVEL). Accents (tick, click, keys) sit a little lower.
KIT = {
    "whoosh": (lambda: whoosh(0.45), 0),
    "whoosh-long": (lambda: whoosh(0.95, 260, 2000, 0.6), 0),
    "swoosh": (swoosh, 0),
    "pop": (lambda: pop(520), -2),
    "pop-low": (lambda: pop(300, 0.2), -2),
    "pop-high": (lambda: pop(900, 0.13), -3),
    "tick": (tick, -6),
    "click": (click, -5),
    "typing": (typing, -6),
    "ding": (ding, -1),
    "error": (error, -3),
    "riser": (riser, -2),
    "thud": (thud, 0),
    "paper": (paper, -3),
    "glitch": (glitch, -4),
}

# BS.1770 K-weighting at 48 kHz.
K1 = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
K2 = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])


def momentary_max(x):
    # Loudest 400 ms window (100 ms hop), padded with silence for sounds shorter than that.
    y = biquad(biquad(np.concatenate([x, np.zeros(int(SR * 0.4))]), *K1), *K2)
    win, hop = int(SR * 0.4), int(SR * 0.1)
    ms = [np.mean(y[i: i + win] ** 2) for i in range(0, len(y) - win + 1, hop)]
    return -0.691 + 10 * np.log10(max(ms) + 1e-20)


def write(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


if __name__ == "__main__":
    only = set(sys.argv[1:])
    for name, (make, trim) in KIT.items():
        if only and name not in only:
            continue
        x = make()
        x = x / (np.abs(x).max() + 1e-12)
        target = LEVEL + trim
        x *= 10 ** ((target - momentary_max(x)) / 20)
        peak = 20 * np.log10(np.abs(x).max())
        if peak > -1:
            print(f"warning: {name} peaks at {peak:.1f} dBFS", file=sys.stderr)
        write(os.path.join(OUT, f"{name}.wav"), x)
        print(f"{name:12s} {len(x) / SR:5.2f} s  {momentary_max(x):6.1f} LUFS M max  peak {peak:5.1f} dBFS")
