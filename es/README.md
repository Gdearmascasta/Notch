# Isle en español (rama `es-personal`)

Fork personal de [Isle](https://github.com/zickrian/isle) v1.4.0 (GPL-3.0-or-later).

Cambios sobre `gnome-extension/`:

- Interfaz traducida al español (631 textos visibles; los nombres D-Bus siguen en inglés).
- Opciones de idioma de voz `es` y `es,en`.
- Isla cerrada en negro al 85 % con borde interior blanco al 12 % (`ISLAND_ALPHA`, `BORDER_ALPHA` en `src/island.js`); la ventana abierta usa negro sólido sin borde.
- Con música sonando, la isla cerrada toma el color de la carátula con tinte `wash` (`pages/media.js`, `controller.js`).
- Barras de sonido del notch a 18 px (`compact.js`).
- El portapapeles es una lista de filas de una línea (icono, texto y antigüedad) en vez de tarjetas de 136×96 px; ↑ ↓ mueven la selección (`es/lista-portapapeles.patch`).
- La isla cerrada muestra el asistente (el fantasma, parpadeando cada pocos segundos) en lugar de la hora, y el reloj de GNOME vuelve a la barra, a la izquierda con Just Perfection (`clock-menu-position=2`), con su calendario (`es/fantasma-reloj.patch`).
- La página de música toma el degradado del color de la carátula también en el reproductor, no solo en la letra (`es/musica-degradado.patch`).

Los textos que genera el demonio `isled` siguen en inglés.

El asistente se llama **Ela**: lo dice el prompt de `crates/isle-daemon/src/assistant/mod.rs` (`instructions`) y los subtítulos de sus avisos. El prompt va compilado en `isled`, así que `reaplicar.sh` no lo restaura: tras actualizar Isle hay que recompilar (`cargo build --release -p isle-daemon`) y copiar `target/release/isled` a `~/.local/bin/`. El binario original está en `~/.config/isle-es/isled-1.4.0-original`.

## Reaplicar sobre una instalación actualizada

`es/reaplicar.sh` aplica `es.py` (diccionario), `apply.py`, `extras.py` y los `*.patch` sobre la extensión instalada en
`~/.local/share/gnome-shell/extensions/isle@zickrian.github.io` y comprueba la sintaxis con `node --check`.
Después hay que cerrar sesión y volver a entrar.
