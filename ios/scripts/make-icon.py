#!/usr/bin/env python3
"""Render ios/App/Resources/AppIcon.png (1024x1024, opaque) for LOJO Mail.

Run with any Python that has Pillow, e.g. ~/.local/share/ios-dev-venv/bin/python.
"""
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 3
S = SIZE * SS

TOP = (14, 116, 128)
BOTTOM = (38, 42, 112)

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "App", "Resources", "AppIcon.png")
if len(sys.argv) > 1:
    out = sys.argv[1]

img = Image.new("RGB", (S, S))
grad = Image.linear_gradient("L").resize((S, S))
top = Image.new("RGB", (S, S), TOP)
bottom = Image.new("RGB", (S, S), BOTTOM)
img = Image.composite(bottom, top, grad)

glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
cx, cy = S * 0.5, S * 0.5
gd.ellipse([cx - S * 0.38, cy - S * 0.34, cx + S * 0.38, cy + S * 0.42], fill=(120, 230, 220, 55))
glow = glow.filter(ImageFilter.GaussianBlur(S * 0.06))
img.paste(glow, (0, 0), glow)

d = ImageDraw.Draw(img)
white = (245, 252, 251)
line = (20, 110, 124)

# Envelope body.
left, right = S * 0.20, S * 0.80
top_y, bottom_y = S * 0.32, S * 0.70
radius = S * 0.05
d.rounded_rectangle([left, top_y, right, bottom_y], radius=radius, fill=white)
# Flap.
w = int(S * 0.026)
d.line([(left + radius * 0.6, top_y + radius * 0.5), (cx, S * 0.53), (right - radius * 0.6, top_y + radius * 0.5)], fill=line, width=w, joint="curve")
# Lower folds.
d.line([(left + radius * 0.5, bottom_y - radius * 0.4), (S * 0.42, S * 0.51)], fill=(200, 226, 228), width=int(w * 0.6))
d.line([(right - radius * 0.5, bottom_y - radius * 0.4), (S * 0.58, S * 0.51)], fill=(200, 226, 228), width=int(w * 0.6))

# Lock badge.
bx, by, br = S * 0.72, S * 0.70, S * 0.13
d.ellipse([bx - br, by - br, bx + br, by + br], fill=(72, 214, 160), outline=white, width=int(S * 0.018))
body_w, body_h = br * 0.95, br * 0.72
d.rounded_rectangle([bx - body_w / 2, by - body_h * 0.25, bx + body_w / 2, by + body_h * 0.75], radius=S * 0.012, fill=white)
shackle = br * 0.34
d.arc([bx - shackle, by - body_h * 0.25 - shackle * 1.6, bx + shackle, by - body_h * 0.25 + shackle * 0.4], start=180, end=360, fill=white, width=int(S * 0.02))
d.ellipse([bx - S * 0.012, by + body_h * 0.12, bx + S * 0.012, by + body_h * 0.36], fill=(20, 110, 124))

img = img.resize((SIZE, SIZE), Image.LANCZOS)
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out, "PNG")
print(out)
