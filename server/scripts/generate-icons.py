#!/usr/bin/env python3
"""Иконки ярлыка портала: щит с замочной скважиной на синем фоне.

Нужен Pillow (pip install pillow). Запуск из server/: python3 scripts/generate-icons.py
Фон — на весь квадрат, рисунок — в центральных 60%: так иконку можно отдавать и как
maskable (Android обрезает её до круга или скруглённого квадрата), и как apple-touch-icon
(iOS скругляет углы сам).
"""
from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = (37, 99, 235)
WHITE = (255, 255, 255)
SCALE = 4  # рисуем крупнее и уменьшаем — так края сглаживаются
BASE = 512
OUT = Path(__file__).resolve().parent.parent / 'src' / 'static'


def shield_points(size):
    s = size / 100
    left, right, top, mid, bottom = 28 * s, 72 * s, 25 * s, 50 * s, 82 * s
    center = 50 * s

    # бока щита — квадратичные кривые Безье, выпуклые наружу
    def side(edge, steps=32):
        control = (edge, mid + 0.8 * (bottom - mid))
        return [
            ((1 - t) ** 2 * edge + 2 * (1 - t) * t * control[0] + t ** 2 * center,
             (1 - t) ** 2 * mid + 2 * (1 - t) * t * control[1] + t ** 2 * bottom)
            for t in (i / steps for i in range(steps + 1))
        ]

    return [(center, 18 * s), (right, top), *side(right), *reversed(side(left)), (left, top)]


def draw_icon(size):
    big = size * SCALE
    image = Image.new('RGB', (big, big), ACCENT)
    draw = ImageDraw.Draw(image)
    draw.polygon(shield_points(big), fill=WHITE)
    s = big / 100
    draw.ellipse((44 * s, 38 * s, 56 * s, 50 * s), fill=ACCENT)
    draw.polygon([(47 * s, 46 * s), (53 * s, 46 * s), (55 * s, 64 * s), (45 * s, 64 * s)], fill=ACCENT)
    return image.resize((size, size), Image.LANCZOS)


def main():
    master = draw_icon(BASE)
    for size, name in ((512, 'icon-512.png'), (192, 'icon-192.png'), (180, 'icon-180.png')):
        icon = master if size == BASE else master.resize((size, size), Image.LANCZOS)
        icon.save(OUT / name, optimize=True)
        print(OUT / name)


if __name__ == '__main__':
    main()
