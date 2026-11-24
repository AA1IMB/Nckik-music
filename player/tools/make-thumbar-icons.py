#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 Windows 任务栏缩略图工具栏图标（上一首 / 播放 / 暂停 / 下一首）。

输出：
  player/assets/thumbar/dark/{prev,play,pause,next}.png    32×32（浅色字形，用于深色任务栏）
  player/assets/thumbar/light/{prev,play,pause,next}.png   32×32（深色字形，用于浅色任务栏）

几何坐标与 renderer/index.html 中的主界面控制按钮（24×24 viewBox）保持一致，
以 256×256 渲染后经 LANCZOS 抗锯齿缩放到 32×32，适配 Windows 各档 DPI。
"""
import os
import sys
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', 'assets', 'thumbar'))

CANVAS = 256
OUT_SIZE = 32
VIEWBOX = 24.0
# 四周留一点安全边距，避免在 Windows 缩略图按钮框内显得过满
PAD = 0.08

THEMES = {
    'dark': (245, 245, 247, 255),   # 深色任务栏上的浅色图标
    'light': (28, 28, 30, 255),     # 浅色任务栏上的深色图标
}


def sx(v):
    usable = CANVAS * (1.0 - 2.0 * PAD)
    return CANVAS * PAD + (v / VIEWBOX) * usable


def draw_prev(d, color):
    # 与 index.html #btnPrev 一致：竖条 (5.6, 5, 2.4, 14, rx=1.2) + 左三角
    d.rounded_rectangle(
        [sx(5.2), sx(4.8), sx(8.0), sx(19.2)],
        radius=sx(1.3) - sx(0),
        fill=color,
    )
    d.polygon(
        [(sx(19.2), sx(5.0)), (sx(19.2), sx(19.0)), (sx(9.2), sx(12.0))],
        fill=color,
    )


def draw_next(d, color):
    # 与 index.html #btnNext 一致：右三角 + 竖条
    d.polygon(
        [(sx(4.8), sx(5.0)), (sx(4.8), sx(19.0)), (sx(14.8), sx(12.0))],
        fill=color,
    )
    d.rounded_rectangle(
        [sx(16.0), sx(4.8), sx(18.8), sx(19.2)],
        radius=sx(1.3) - sx(0),
        fill=color,
    )


def draw_play(d, color):
    # 与 index.html #icPlay 一致：光学居中的右三角
    d.polygon(
        [(sx(7.6), sx(4.6)), (sx(19.2), sx(12.0)), (sx(7.6), sx(19.4))],
        fill=color,
    )


def draw_pause(d, color):
    # 与 index.html #icPause 一致：两条圆角竖条
    r = sx(1.6) - sx(0)
    d.rounded_rectangle([sx(6.2), sx(4.6), sx(10.4), sx(19.4)], radius=r, fill=color)
    d.rounded_rectangle([sx(13.6), sx(4.6), sx(17.8), sx(19.4)], radius=r, fill=color)


ICONS = {
    'prev': draw_prev,
    'play': draw_play,
    'pause': draw_pause,
    'next': draw_next,
}


def main():
    for theme, color in THEMES.items():
        tdir = os.path.join(OUT, theme)
        os.makedirs(tdir, exist_ok=True)
        for name, fn in ICONS.items():
            img = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
            fn(ImageDraw.Draw(img), color)
            out = img.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
            out.save(os.path.join(tdir, name + '.png'))
    print('thumbar icons ->', OUT)
    return 0


if __name__ == '__main__':
    sys.exit(main())
