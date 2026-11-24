#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 novel-writer 图标（多尺寸 .ico）。用法：python tools/make_icon.py"""
import sys, os
from PIL import Image, ImageDraw

sys.stdout.reconfigure(encoding="utf-8")

BG      = (30, 30, 30, 255)     # VS Code 编辑器底
EDGE    = (60, 60, 60, 255)
PAPER   = (245, 243, 238, 255)
FOLD    = (200, 196, 188, 255)
YELLOW  = (220, 220, 170, 255)  # 章节标题黄
BLUE    = (86, 156, 214, 255)   # 类型青蓝
GREY    = (150, 150, 150, 255)
ORANGE  = (206, 145, 120, 255)  # 对话字符串橙

S = 256 * 4  # 4 倍超采样，缩到 256 再各尺寸降采样


def rounded(d, box, r, fill):
    d.rounded_rectangle(box, radius=r, fill=fill)


def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 背景：圆角方块 + 细边
    m = int(S * 0.02)
    rounded(d, (m, m, S - m, S - m), int(S * 0.20), EDGE)
    rounded(d, (m * 2, m * 2, S - m * 2, S - m * 2), int(S * 0.185), BG)

    # 纸张（带右上折角）
    pw, ph = int(S * 0.52), int(S * 0.66)
    x0 = (S - pw) // 2
    y0 = (S - ph) // 2
    x1, y1 = x0 + pw, y0 + ph
    fold = int(pw * 0.30)
    d.polygon([(x0, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1), (x0, y1)], fill=PAPER)
    d.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=FOLD)

    # 纸上的“正文行”：标题黄、对话橙、正文灰、书名蓝
    lx = x0 + int(pw * 0.13)
    lr = x1 - int(pw * 0.13)
    lh = int(ph * 0.045)
    gap = int(ph * 0.085)
    y = y0 + int(ph * 0.20)
    rows = [
        (YELLOW, 1.00),
        (GREY,   0.82),
        (ORANGE, 0.92),
        (GREY,   0.64),
        (BLUE,   0.86),
        (GREY,   0.74),
    ]
    for color, w in rows:
        d.rounded_rectangle((lx, y, lx + int((lr - lx) * w), y + lh),
                            radius=lh // 2, fill=color)
        y += gap

    # 右下角一支斜插的铅笔（强调“写作”）
    pen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pen)
    bw = int(S * 0.115)                       # 笔杆宽
    bx0, bx1 = int(S * 0.60), int(S * 0.60) + bw
    by0, by1 = int(S * 0.12), int(S * 0.66)   # 笔杆竖向范围
    pd.rounded_rectangle((bx0, by0, bx1, by1), radius=int(S * 0.015), fill=YELLOW)
    mid = (bx0 + bx1) // 2
    ph = int(S * 0.14)                        # 笔尖三角高
    pd.polygon([(bx0, by1), (bx1, by1), (mid, by1 + ph)], fill=PAPER)
    pd.polygon([(bx0, by0), (bx1, by0),
                (mid, by0 - int(S * 0.07))], fill=ORANGE)   # 橡皮/尾端
    pen = pen.rotate(-42, resample=Image.BICUBIC, center=(mid, (by0 + by1) // 2))
    img.alpha_composite(pen)

    return img.resize((256, 256), Image.LANCZOS)


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "novel-writer.ico")
    base = draw()
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]
    base.save(out, format="ICO", sizes=sizes)
    base.save(out.replace(".ico", ".png"))
    print("已生成：", out)


if __name__ == "__main__":
    main()
