"""README badge: a small SVG skyline of a repository's city, drawn from its stored result.

Pure functions of schema-validated data. The only text is the repo slug (already `^[a-z0-9._/-]+$`) and
numbers, and it is XML-escaped anyway. No script, no style element, no external references.
"""

from __future__ import annotations

import math
from html import escape

from core.schema import Result

W, H = 320, 96
GROUND = 76
MAX_TOWERS = 48
_BG = (
    '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0" stop-color="#0b0f24"/><stop offset="1" stop-color="#2a1a3e"/></linearGradient></defs>'
    f'<rect width="{W}" height="{H}" rx="6" fill="url(#s)"/>'
    '<circle cx="292" cy="18" r="7" fill="#f4e9d0" opacity="0.85"/>'
)


def _svg(label: str, body: str, caption: str) -> bytes:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" '
        f'role="img" aria-label="{escape(label)}"><title>{escape(label)}</title>{_BG}{body}'
        f'<rect y="{GROUND}" width="{W}" height="{H - GROUND}" rx="0" fill="#07091a" opacity="0.7"/>'
        f'<text x="10" y="{H - 7}" font-family="system-ui,sans-serif" font-size="11" fill="#e8dcc4">'
        f"{escape(caption)}</text></svg>"
    ).encode()


def render(r: Result) -> bytes:
    """Towers for the most-changed files (height = changes, log scale), grouped by district."""
    top = sorted(range(len(r.files)), key=lambda i: (-r.files[i].changes, r.files[i].path))[:MAX_TOWERS]
    top.sort(key=lambda i: (r.files[i].dir, r.files[i].path))
    peak = math.log1p(max((r.files[i].changes for i in top), default=0)) or 1.0
    step = (W - 20) / max(len(top), 1)
    towers = []
    for n, i in enumerate(top):
        f = r.files[i]
        h = 6 + (GROUND - 22) * math.log1p(f.changes) / peak
        fill = "#ffb45e" if f.hot else "#3a3f63" if f.dead else "#6f74b8"
        towers.append(
            f'<rect x="{10 + n * step:.1f}" y="{GROUND - h:.1f}" width="{max(step - 1.5, 1):.1f}" '
            f'height="{h:.1f}" fill="{fill}"/>'
        )
    shown = f"{len(top)} most-changed of {r.meta.files:,} files" if r.meta.files > len(top) else "all files"
    label = f"Afterglow city of {r.meta.repo} at {r.meta.sha[:7]}: {shown}, height = changes, amber = hotspot"
    return _svg(label, "".join(towers), f"{r.meta.repo} · afterglow")


def placeholder(slug: str) -> bytes:
    """No stored analysis for this repository (yet, or any more): say so instead of drawing a city."""
    return _svg(f"{slug} has not been analysed recently on Afterglow", "", f"{slug} · not analysed yet")
