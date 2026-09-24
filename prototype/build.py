import re,pathlib
r=pathlib.Path(__file__).parent
S=lambda n:(r/'src'/n).read_text()
fonts='<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400;1,500&family=IBM+Plex+Mono:wght@400;500&family=Instrument+Sans:wght@400;500;600&display=swap">'
js='\n'.join(S(n) for n in ['util.js','world.js','gl.js','app.js'])
frag=f'<title>Afterglow</title>\n{fonts}\n<style>\n{S("style.css")}\n</style>\n{S("body.html")}\n<script>\n{js}\n</script>\n'
(r/'dist').mkdir(exist_ok=True)
(r/'dist'/'afterglow.html').write_text(frag)
(r/'dist'/'test.html').write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>'+frag+'</body></html>')
print(len(frag)//1024,'KB')
