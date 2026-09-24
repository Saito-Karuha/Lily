"""Cuts the engraved lily out of the hero concept image and prepares it for the page.

    python3 scripts/prepare-art.py [path/to/lily_sample2.png]

The concept (lily_sample2.png, 1536x1024) has the flower on the right ~55%. This script
crops it, paints out the text baked into the concept (nav, taglines, bottom band) and
divides by the paper colour so the background becomes pure white. On the page the image
is drawn with `mix-blend-mode: multiply`, so white disappears into whatever cream the page
uses and only ink and the lavender wash remain. Output: src/assets/lily-art.webp (checked
in; the build does not need the concept image).
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
SOURCE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SITE, "..", "..", "lily_sample2.png")
OUT = os.path.join(SITE, "src", "assets", "lily-art.webp")

CROP = (690, 28, 1530, 1024)  # left, top, right, bottom in concept pixels
# Text baked into the concept, in concept pixels (x0, y0, x1, y1).
ERASE = [
    (1188, 28, 1482, 68),  # nav: Docs GitHub Changelog
    (1394, 596, 1484, 688),  # CURIOSITY BUILDS A KINDER TOMORROW + rule
    (1394, 801, 1484, 890),  # SMALL AGENTS BRIGHTER WORLDS + rule
    (1380, 968, 1476, 996),  # WITH LILY
    (690, 936, 945, 1004),  # Compose. Run. Iterate.
]
BAND_ROWS = (955, 964)  # rows just above/below the thin rule of the bottom band (x >= 945)

img = np.asarray(Image.open(SOURCE).convert("RGB")).astype(np.float32)
h, w, _ = img.shape

# Paper colour estimate: a smooth map of the bright end of each 32px block.
B = 32
bh, bw = h // B, w // B
blocks = img[: bh * B, : bw * B].reshape(bh, B, bw, B, 3).transpose(0, 2, 1, 3, 4).reshape(bh, bw, B * B, 3)
paper_small = np.percentile(blocks, 85, axis=2)
# Blocks that are mostly ink would give a dark estimate: replace them with the global paper colour.
global_paper = np.median(paper_small.reshape(-1, 3), axis=0)
dark = paper_small.min(axis=2) < global_paper.min() - 10
paper_small[dark] = global_paper
paper_img = Image.fromarray(np.clip(paper_small, 0, 255).astype(np.uint8)).resize((w, h), Image.BICUBIC).filter(ImageFilter.GaussianBlur(24))
paper = np.asarray(paper_img).astype(np.float32)
paper = np.maximum(paper, global_paper - 6)

for x0, y0, x1, y1 in ERASE:
    img[y0:y1, x0:x1] = paper[y0:y1, x0:x1]

y0, y1 = BAND_ROWS
# Interpolate across the rule along the stem's slant, so where it crosses the stem the stem continues.
SLANT = 0.58  # the stem moves this many px left per row going down
xs = np.arange(945, w)
for y in range(y0 + 1, y1):
    t = (y - y0) / (y1 - y0)
    above = np.clip(np.round(xs + SLANT * (y - y0)).astype(int), 0, w - 1)
    below = np.clip(np.round(xs - SLANT * (y1 - y)).astype(int), 0, w - 1)
    img[y, 945:] = img[y0, above] * (1 - t) + img[y1, below] * t

# Divide out the paper, then push near-white grain to pure white.
out = np.clip(img / paper * 255.0, 0, 255)
lightness = out.min(axis=2, keepdims=True)
t = np.clip((lightness - 232.0) / (249.0 - 232.0), 0, 1)
out = out * (1 - t) + 255.0 * t

left, top, right, bottom = CROP
art = Image.fromarray(out[top:bottom, left:right].astype(np.uint8))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
art.save(OUT, "WEBP", quality=90, method=6)
print(f"wrote {OUT} {art.size[0]}x{art.size[1]}")
