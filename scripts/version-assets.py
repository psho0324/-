"""Refresh local script/style URLs after code changes (no external dependencies)."""
from pathlib import Path
import hashlib
import re

root = Path(__file__).resolve().parent.parent
for page in (root / 'index.html', root / 'admin.html'):
    text = page.read_text()
    def replace(match):
        prefix, name, suffix = match.groups()
        digest = hashlib.sha256((root / name).read_bytes()).hexdigest()[:12]
        return f'{prefix}{name}?v={digest}{suffix}'
    text = re.sub(r'((?:src|href)=")([a-z-]+\.(?:js|css))(?:\?v=[a-f0-9]+)?(")', replace, text)
    page.write_text(text)
