#!/usr/bin/env python3
"""合成蛇域前端音效（16-bit PCM WAV），输出到 static/assets/sfx/。

只用标准库；所有音色为程序化合成，避免外部素材版权问题。
用法: python scripts/generate-sfx.py
"""

from __future__ import annotations

import math
import random
import struct
import wave
from pathlib import Path

SAMPLE_RATE = 22050
OUT_DIR = Path(__file__).resolve().parent.parent / "static" / "assets" / "sfx"


def write_wav(name: str, samples: list[float]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{name}.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        frames = b"".join(
            struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in samples
        )
        wav.writeframes(frames)
    print(f"wrote {path}")


def envelope(t: float, duration: float, attack: float = 0.01, release: float = 0.3) -> float:
    """简单起音/释音包络，t 为 0..1 进度。"""
    attack_t = max(attack, 1e-4)
    release_t = max(release, 1e-4)
    if t < attack_t:
        return t / attack_t
    if t > 1 - release_t:
        return max(0.0, (1 - t) / release_t)
    return 1.0


def tone(
    duration: float,
    freq_start: float,
    freq_end: float,
    volume: float = 0.5,
    shape: str = "sine",
    attack: float = 0.01,
    release: float = 0.3,
) -> list[float]:
    count = int(SAMPLE_RATE * duration)
    out = []
    phase = 0.0
    for i in range(count):
        t = i / count
        freq = freq_start + (freq_end - freq_start) * t
        phase += freq / SAMPLE_RATE
        if shape == "sine":
            sample = math.sin(phase * math.tau)
        elif shape == "square":
            sample = 1.0 if math.sin(phase * math.tau) > 0 else -1.0
        elif shape == "saw":
            sample = 2.0 * (phase % 1.0) - 1.0
        else:
            sample = math.sin(phase * math.tau)
        out.append(sample * volume * envelope(t, duration, attack, release))
    return out


def noise_burst(duration: float, volume: float = 0.4, decay: float = 3.0) -> list[float]:
    rng = random.Random(42)
    count = int(SAMPLE_RATE * duration)
    out = []
    for i in range(count):
        t = i / count
        out.append(rng.uniform(-1, 1) * volume * math.exp(-decay * t))
    return out


def mix(*tracks: list[float]) -> list[float]:
    length = max(len(t) for t in tracks)
    out = [0.0] * length
    for track in tracks:
        for i, sample in enumerate(track):
            out[i] += sample
    peak = max(0.001, max(abs(s) for s in out))
    if peak > 1.0:
        out = [s / peak * 0.95 for s in out]
    return out


def concat(*tracks: list[float]) -> list[float]:
    out: list[float] = []
    for track in tracks:
        out.extend(track)
    return out


def main() -> None:
    # 吃食物：短促上扬的电子音
    write_wav("eat", tone(0.09, 620, 990, volume=0.45, attack=0.02, release=0.5))

    # 连击/吃大餐：更高更快的双音
    write_wav(
        "eat-big",
        concat(tone(0.06, 700, 950, volume=0.4, release=0.4), tone(0.09, 950, 1350, volume=0.45, release=0.5)),
    )

    # 加速循环：柔和滤波噪声（可无缝循环）
    duration = 0.9
    count = int(SAMPLE_RATE * duration)
    rng = random.Random(7)
    raw = [rng.uniform(-1, 1) for _ in range(count)]
    loop: list[float] = []
    for i in range(count):
        t = i / count
        # 低通平滑 + 首尾交叉淡化保证循环无缝
        smoothed = sum(raw[max(0, i - 6): i + 1]) / len(raw[max(0, i - 6): i + 1])
        crossfade = 0.5 - 0.5 * math.cos(t * math.tau)
        loop.append(smoothed * 0.32 * (0.6 + 0.4 * crossfade))
    write_wav("boost", loop)

    # 死亡：下滑锯齿 + 噪声爆裂
    write_wav(
        "death",
        mix(tone(0.55, 320, 60, volume=0.5, shape="saw", attack=0.01, release=0.4), noise_burst(0.4, volume=0.35)),
    )

    # 击杀：上扬双音号角
    write_wav(
        "kill",
        concat(tone(0.1, 440, 440, volume=0.45, shape="square", release=0.2), tone(0.22, 660, 880, volume=0.45, shape="square", release=0.5)),
    )

    # 重生：三连上扬琶音
    write_wav(
        "respawn",
        concat(
            tone(0.09, 520, 520, volume=0.4, release=0.3),
            tone(0.09, 660, 660, volume=0.4, release=0.3),
            tone(0.16, 880, 1040, volume=0.45, release=0.5),
        ),
    )

    # UI 点击：极短滴答
    write_wav("click", tone(0.045, 900, 700, volume=0.35, attack=0.005, release=0.6))

    # 警告（接近边界）：低频脉冲
    write_wav("warn", tone(0.16, 180, 160, volume=0.4, shape="square", attack=0.02, release=0.4))


if __name__ == "__main__":
    main()
