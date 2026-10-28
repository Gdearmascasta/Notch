# Isle del color de la barra y opciones de voz en español; cada cambio se salta si ya está o si el código cambió
import sys,os
root=sys.argv[1]
def patch(rel, pairs):
    p=os.path.join(root,rel); s=open(p).read()
    for a,b in pairs:
        if b in s: continue
        if s.count(a)!=1: print(f"AVISO {rel}: no encontré el fragmento, revísalo a mano:\n  {a.splitlines()[0]}"); continue
        s=s.replace(a,b)
    open(p,'w').write(s)
patch('src/island.js', [
("""        this._outline(cr, height);
        cr.setSourceRGBA(0, 0, 0, 1);""",
"""        this._outline(cr, height);
        cr.setSourceRGBA(0, 0, 0, this._solid ? 1 : ISLAND_ALPHA);"""),
("""        this._topInset = 0;
        this._hovered = false;""",
"""        this._topInset = 0;
        /** Whether the island shows more than its closed view: open, it is solid black, as Isle draws it. */
        this._solid = false;
        this._hovered = false;"""),
("""    /** The top bar's height, as last set. */""",
"""    /** Whether the island is drawn solid black instead of see-through. */
    set solid(solid) {
        if (solid === this._solid)
            return;
        this._solid = solid;
        this._shape.queue_repaint();
    }

    /** The top bar's height, as last set. */"""),
("""/** How long a tint takes to come and go""",
"""/** How opaque the closed island's black is: nearly solid, so what is behind it never shows through its text. */
const ISLAND_ALPHA = 0.85;
/** A faint light edge, so the island still stands out on a dark wallpaper. */
const BORDER_ALPHA = 0.12;
/** How long a tint takes to come and go"""),
("""                cr.fillPreserve();
            }
        }
        cr.newPath();
        cr.$dispose();""",
"""                cr.fillPreserve();
            }
        }
        cr.newPath();
        if (this._solid) {
            cr.$dispose();
            return;
        }
        // The edge is drawn inside the shape, and not along the screen's top, which the island hangs from.
        cr.save();
        cr.rectangle(-SHAPE_PAD, px(1), 100000, height);
        cr.clip();
        this._outline(cr, height);
        cr.clipPreserve();
        cr.setSourceRGBA(1, 1, 1, BORDER_ALPHA);
        cr.setLineWidth(px(2));
        cr.stroke();
        cr.restore();
        cr.$dispose();"""),
])
patch('src/controller.js', [
("""        this._island.morph(size, view);""",
"""        this._island.solid = view !== this._compact;
        this._island.morph(size, view);"""),
])
patch('src/pages/media.js', [
("""    /** Whether `mode` is on screen (the special modes need a track). */""",
"""    /** The cover's colour while a song plays, for the closed island to take; null otherwise. */
    get coverTint() {
        const {nowPlaying} = this.daemon.state;
        return !this.hidden && nowPlaying?.status === 'Playing' && Playback.hasTrack(nowPlaying) ? this._tint ?? null : null;
    }

    /** Whether `mode` is on screen (the special modes need a track). */"""),
("""        if (this.hidden)
            return;
        const {nowPlaying} = this.daemon.state;
        if (!this._syncMode())""",
"""        if (this.hidden)
            return;
        const coverTint = this.coverTint;
        if (coverTint !== this._coverTintShown) {
            this._coverTintShown = coverTint;
            this.emit('tint-changed');
        }
        const {nowPlaying} = this.daemon.state;
        if (!this._syncMode())"""),
("""            this._tint = vividColorOfFile(cover ?? path);
            if (this._shown('lyrics'))
                this.emit('tint-changed');""",
"""            this._tint = vividColorOfFile(cover ?? path);
            this._coverTintShown = this.coverTint;
            this.emit('tint-changed');"""),
])
patch('src/compact.js', [
("""        this._bars = new Bars({height: 16});""", """        this._bars = new Bars({height: 18});"""),
("""        this._secondBars = new Bars({height: 16});""", """        this._secondBars = new Bars({height: 18});"""),
])
patch('src/controller.js', [
("""        expanded.connect('tint-changed', () => this._syncTint());""",
"""        expanded.connect('tint-changed', () => this._syncTint());
        // The closed island takes the playing song's cover colour, so the music page tells it of a new one.
        expanded.pageNamed('music')?.connect('tint-changed', () => this._syncTint());"""),
("""        const tint = voice ? this._botLook.palette.glow : glow ?? (expanded ? this._expanded.tint : null);
        const style = voice || glow ? 'aura' : expanded ? this._expanded.tintStyle : null;""",
"""        const cover = this._presentation === 'compact' ? this._expanded.pageNamed('music')?.coverTint ?? null : null;
        const tint = voice ? this._botLook.palette.glow : glow ?? (expanded ? this._expanded.tint : cover);
        const style = voice || glow ? 'aura' : expanded ? this._expanded.tintStyle : cover ? 'wash' : null;"""),
])
patch('prefs.js', [
("            ['', 'Cualquiera (detectado)'],\n",
 "            ['', 'Cualquiera (detectado)'],\n            ['es', 'Español'],\n            ['es,en', 'Español o inglés'],\n"),
])
