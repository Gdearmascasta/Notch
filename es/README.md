# Isle en español (rama `es-personal`)

Fork personal de [Isle](https://github.com/zickrian/isle) v1.4.0 (GPL-3.0-or-later).

Cambios sobre `gnome-extension/`:

- Interfaz traducida al español (631 textos visibles; los nombres D-Bus siguen en inglés).
- Opciones de idioma de voz `es` y `es,en`.
- Isla cerrada en negro al 85 % con borde interior blanco al 12 % (`ISLAND_ALPHA`, `BORDER_ALPHA` en `src/island.js`); la ventana abierta usa negro sólido sin borde.
- Con música sonando, la isla cerrada toma el color de la carátula con tinte `wash` (`pages/media.js`, `controller.js`).
- Barras de sonido del notch a 18 px (`compact.js`).

Los textos que genera el demonio `isled` siguen en inglés.

## Reaplicar sobre una instalación actualizada

`es/reaplicar.sh` aplica `es.py` (diccionario), `apply.py` y `extras.py` sobre la extensión instalada en
`~/.local/share/gnome-shell/extensions/isle@zickrian.github.io` y comprueba la sintaxis con `node --check`.
Después hay que cerrar sesión y volver a entrar.
