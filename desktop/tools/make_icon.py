import os
import sys
from PIL import Image, ImageChops, ImageDraw

out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)

S = 1024  # 4배 크게 그린 뒤 줄여서 부드럽게


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


# 배경: 파란 그라데이션 둥근 사각형
bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
grad = Image.new("RGBA", (S, S))
gp = grad.load()
top, bottom = (79, 142, 247), (37, 99, 235)
for y in range(S):
    c = lerp(top, bottom, y / (S - 1))
    for x in range(S):
        gp[x, y] = c + (255,)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((40, 40, S - 40, S - 40), radius=210, fill=255)
bg.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(bg)

# 달력 종이 (흰색) + 아래 그림자
page = (170, 250, S - 170, S - 150)
d.rounded_rectangle((page[0], page[1] + 16, page[2], page[3] + 16), radius=70, fill=(0, 0, 0, 50))
d.rounded_rectangle(page, radius=70, fill=(255, 255, 255, 255))

# 윗부분 빨간 띠
header = Image.new("RGBA", (S, S), (0, 0, 0, 0))
hd = ImageDraw.Draw(header)
hd.rounded_rectangle(page, radius=70, fill=(239, 68, 68, 255))
cut = Image.new("L", (S, S), 0)
ImageDraw.Draw(cut).rectangle((0, 0, S, page[1] + 190), fill=255)
bg.paste(header, (0, 0), ImageChops.multiply(header.split()[3], cut))

# 달력 고리 2개
for cx in (340, S - 340):
    d.rounded_rectangle((cx - 28, 180, cx + 28, 330), radius=28, fill=(255, 255, 255, 255))
    d.rounded_rectangle((cx - 14, 196, cx + 14, 314), radius=14, fill=(180, 40, 40, 255))

# 날짜 칸 (3x3 점) 중 하나는 파란 원 + 체크 표시
x0, y0 = 275, 520
dx, dy = 237, 115
for r in range(3):
    for c in range(3):
        cx, cy = x0 + c * dx + 60, y0 + r * dy + 40
        if (r, c) == (1, 1):
            continue
        d.rounded_rectangle((cx - 42, cy - 26, cx + 42, cy + 26), radius=14, fill=(203, 213, 225, 255))

cx, cy = x0 + 1 * dx + 60, y0 + 1 * dy + 40
d.ellipse((cx - 78, cy - 78, cx + 78, cy + 78), fill=(37, 99, 235, 255))
d.line([(cx - 36, cy + 2), (cx - 8, cy + 32), (cx + 40, cy - 28)], fill=(255, 255, 255, 255), width=24, joint="curve")
for p in [(cx - 36, cy + 2), (cx - 8, cy + 32), (cx + 40, cy - 28)]:
    d.ellipse((p[0] - 12, p[1] - 12, p[0] + 12, p[1] + 12), fill=(255, 255, 255, 255))

png = bg.resize((512, 512), Image.LANCZOS)
png.save(os.path.join(out_dir, "icon.png"))
bg.save(
    os.path.join(out_dir, "icon.ico"),
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("ok")
