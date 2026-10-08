"""src/template.html 에 src/engine.js 를 끼워 넣어 단독 index.html 을 만든다."""
from pathlib import Path
src = Path(__file__).resolve().parent
html = (src / 'template.html').read_text(encoding='utf-8')
engine = (src / 'engine.js').read_text(encoding='utf-8')
assert '/*__ENGINE__*/' in html
(src.parent / 'index.html').write_text(html.replace('/*__ENGINE__*/', engine), encoding='utf-8')
print('index.html built')
