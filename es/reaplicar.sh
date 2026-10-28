#!/bin/bash
# Vuelve a poner Isle en español con los ajustes visuales tras una actualización. Luego cierra sesión y vuelve a entrar.
set -e
K="$(cd "$(dirname "$0")" && pwd)"
I=~/.local/share/gnome-shell/extensions/isle@zickrian.github.io
V=$(python3 -c "import json;print(json.load(open('$I/metadata.json')).get('version-name','?'))")
B=~/.config/isle-es/original-$V
[ -d "$B" ] || cp -a "$I" "$B"
python3 -I "$K/apply.py" "$I"
python3 -I "$K/extras.py" "$I"
for p in "$K"/*.patch; do
	patch -p2 -N -s -r - -d "$I" <"$p" || echo "AVISO: $(basename "$p") no se pudo aplicar entero, revísalo a mano"
done
for f in "$I"/prefs.js "$I"/extension.js "$I"/src/*.js "$I"/src/pages/*.js; do node --check "$f"; done
echo "Listo (Isle $V; copia sin tocar en $B). Cierra sesión y vuelve a entrar."
