#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成应用图标：白色背景 + 正红色大写 N，字形居中、四边留白均衡。

输出：
  player/build/icon.png        512×512（窗口图标 / 预览）
  player/build/icon.ico        含 16/32/48/256 四种尺寸（安装包与 exe 图标）
  player/build/icon-preview.png  多尺寸拼版预览（自检用）

只依赖 Pillow。字体优先用系统里的粗体无衬线（Arial Bold / Segoe UI Bold）。
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, '..', 'build'))
os.makedirs(OUT, exist_ok=True)

RED = (227, 30, 36)          # 正红（#E31E24）
WHITE = (255, 255, 255)
CANVAS = 1024                # 内部渲染尺寸，最后按需缩小
MARGIN = 0.14                # 左右留白占画布比例（上下按字形实际包围盒再配平）

FONT_CANDIDATES = [
    r'C:\Windows\Fonts\arialbd.ttf',
    r'C:\Windows\Fonts\segoeuib.ttf',
    r'C:\Windows\Fonts\seguisb.ttf',
    r'C:\Windows\Fonts\arial.ttf',
]


def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    raise SystemExit('找不到可用的字体（试过 %s）' % ', '.join(FONT_CANDIDATES))


def draw_n():
    img = Image.new('RGB', (CANVAS, CANVAS), WHITE)
    d = ImageDraw.Draw(img)

    # 先按画布找一个足够大的字号，再按字形实际包围盒重新居中
    size = int(CANVAS * 0.78)
    font = load_font(size)
    # 用 bbox 量真实墨迹，避免字体自身的上下行距把视觉重心拉偏
    while True:
        l, t, r, b = d.textbbox((0, 0), 'N', font=font)
        w, h = r - l, b - t
        target = CANVAS * (1 - 2 * MARGIN)
        if w >= target * 0.98 or size > CANVAS:
            break
        size += 8
        font = load_font(size)

    l, t, r, b = d.textbbox((0, 0), 'N', font=font)
    w, h = r - l, b - t
    x = (CANVAS - w) / 2 - l
    y = (CANVAS - h) / 2 - t
    d.text((x, y), 'N', font=font, fill=RED)

    # 再裁一次包围盒做「四边等留白」校正：把字块整体缩放到画布中央的方形安全区
    ink = img.crop((int(x + l), int(y + t), int(x + r), int(y + b)))
    side = int(max(ink.width, ink.height) / (1 - 2 * MARGIN))
    canvas = Image.new('RGB', (side, side), WHITE)
    canvas.paste(ink, ((side - ink.width) // 2, (side - ink.height) // 2))
    return canvas.resize((CANVAS, CANVAS), Image.LANCZOS)


def main():
    big = draw_n()
    png512 = big.resize((512, 512), Image.LANCZOS)
    png512.save(os.path.join(OUT, 'icon.png'))

    sizes = [16, 32, 48, 256]
    # Pillow 写多尺寸 ICO：sizes 参数会按给定尺寸逐级缩小写进同一个 ico
    big.resize((256, 256), Image.LANCZOS).save(
        os.path.join(OUT, 'icon.ico'), format='ICO',
        sizes=[(s, s) for s in sizes]
    )

    # 自检拼版：白底上把四个尺寸并排画出来，肉眼确认 16px 仍可辨认
    pad = 12
    total = sum(sizes) + pad * (len(sizes) + 1)
    height = max(sizes) + pad * 2
    sheet = Image.new('RGB', (total, height), (238, 238, 240))
    x = pad
    for s in sizes:
        im = big.resize((s, s), Image.LANCZOS)
        sheet.paste(im, (x, pad + (max(sizes) - s) // 2))
        x += s + pad
    sheet.save(os.path.join(OUT, 'icon-preview.png'))

    print('icon.png / icon.ico / icon-preview.png ->', OUT)
    for s in sizes:
        print('  ico size', s)


if __name__ == '__main__':
    sys.exit(main())
