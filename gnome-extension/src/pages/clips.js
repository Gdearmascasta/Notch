// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Rows for the Shelf page's Clipboard tab, one line each, pinned first, then newest. Click to copy; on hover: pin,
// a hand-off (text to Tasks, images and files to Files) and ×. The keyboard can select and paste.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import * as Format from '../format.js';
import {icon, iconButton, label} from '../widgets.js';
import {SHELF_CAPACITY} from './files.js';

/** isled keeps 20 recent items and up to 10 pinned ones. */
const MAX_CARDS = 30;
const MAX_PINNED = 10;
/** Cards drawn at once (about a screenful); the rest follow a few per frame so opening never stutters. */
const FIRST_CARDS = 6;
const CARDS_PER_IDLE = 6;
/** How long "Copied" and friends stay on a card. */
const FEEDBACK_MS = 900;
/** Looks like code: braces, semicolons at line ends, arrows, tags, indents. */
const CODE_PATTERN = /[{};]\s*$|=>|<\/?[a-z][\w-]*>|^\s{2,}\S|\b(function|const|def|class|import|return)\b/m;

/** The app that an item was copied from, if it is still installed. */
function appFor(appId) {
    return appId ? Shell.AppSystem.get_default().lookup_app(appId) : null;
}

/** Whether `item` matches the search `query` (already lower case): its app's name or what the card shows, or,
 * as isled found (`found`, ids), any of its text. */
function matches(item, query, found) {
    if (!query || found?.has(item.id))
        return true;
    const app = appFor(item.app_id)?.get_name() ?? '';
    return `${item.preview}\n${app}`.toLowerCase().includes(query);
}

/** Signals: `activated` (item, paste): a card was chosen; `paste` when by keyboard. */
export const ClipsView = GObject.registerClass({
    Signals: {
        'activated': {param_types: [GObject.TYPE_JSOBJECT, GObject.TYPE_BOOLEAN]},
    },
}, class ClipsView extends St.Widget {
    /** A list of one-line rows, with an empty state in its place when none match. */
    _init(daemon) {
        super._init({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._daemon = daemon;
        this._kind = null;
        this._pending = 0;
        this.connect('destroy', () => {
            this._destroyed = true;
            this._cancelPending();
        });
        this._query = '';
        /** The items isled found holding `_query` in their whole text (cards show only its start). */
        this._found = null;
        /** A search isled is still answering, and how many were asked for. */
        this._searching = null;
        this._searches = 0;
        this._selected = 0;
        this._keyboard = false;
        /** Every item, pinned first; the cards of those that match `kind` and `query` show. */
        this._all = [];
        this._shown = [];
        /** Drawn cards by item id, in the strip in the order of `_all`. */
        this._cards = new Map();
        /** A card's "Copied" (or similar), kept across redraws while it shows. */
        this._flashing = null;

        this._strip = new St.BoxLayout({...VERTICAL, style_class: 'isle-clips', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'isle-clips-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._strip);
        // The wheel scrolls the list when it overflows, rather than flipping the page.
        this._scroll.connect('scroll-event', (_actor, event) => this._onScroll(event));
        this.add_child(this._scroll);

        this._empty = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'isle-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._emptyIcon = new St.Icon({icon_size: 24, style_class: 'isle-empty-icon'});
        this._emptyTitle = label('', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER});
        this._emptyHint = label('', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER});
        this._empty.add_child(this._emptyIcon);
        this._empty.add_child(this._emptyTitle);
        this._empty.add_child(this._emptyHint);
        this.add_child(this._empty);
    }

    /** Moves the cards' ages ("2m") on, for the page opening again later. */
    refreshAges() {
        for (const card of this._cards.values()) {
            const [ageLabel, age] = card._age;
            ageLabel.text = Format.ago(age);
        }
    }

    /** Shows only items of `kind` ('text', 'link', 'image', 'files'), or all. */
    set kind(kind) {
        this._kind = kind;
        this._selected = 0;
        this._filter();
    }

    /** The search box's words; isled searches the items' whole text. */
    set query(query) {
        query = query.trim().toLowerCase();
        if (query === this._query && !this._searching)
            return;
        this._search(query, {reset: true});
    }

    /** Empties the search without showing the cards it hid yet: the next `update` does. */
    clearQuery() {
        this._searches++;
        this._searching = null;
        this._query = '';
        this._found = null;
        this._selected = 0;
    }

    // Asks isled which items hold `query` in their whole text. The cards change once it answers, from the last
    // search's straight to this one's, so none blink out and back while typing; without isled, by what they show.
    _search(query, {reset = false} = {}) {
        const search = ++this._searches;
        if (!query) {
            this._searching = null;
            [this._query, this._found] = ['', null];
            if (reset)
                this._selected = 0;
            this._filter();
            return;
        }
        this._searching = this._daemon.call('clipboard', 'Search', query).then(result => {
            if (search !== this._searches || this._destroyed)
                return;
            this._searching = null;
            [this._query, this._found] = [query, result ? new Set(result[0]) : null];
            if (reset)
                this._selected = 0;
            this._filter();
        });
    }

    /** Redraws the cards; `off` means clipboard history is switched off, `hidden` that the screen is
     * shared or recorded: either way no card shows, and the empty state says why. Left out, both stay. */
    update({off = this._off, hidden = this._hidden} = {}) {
        this._off = off;
        this._hidden = hidden;
        // Pinned items stay at the front, the rest newest first (as isled
        // sends them).
        const all = hidden ? [] : this._daemon.state.clipboard ?? [];
        this._all = [...all.filter(item => item.pinned), ...all.filter(item => !item.pinned)];

        // An unchanged item keeps its card; a changed or removed one's goes.
        const keys = new Map(this._all.map(item => [item.id, JSON.stringify(item)]));
        for (const [id, card] of this._cards) {
            if (keys.get(id) !== card._key || card._removed) {
                card.destroy();
                this._cards.delete(id);
            }
        }
        // The kept ones in the items' order, which unpinning one changes.
        let previous = null;
        for (const item of this._all) {
            const card = this._cards.get(item.id);
            if (!card)
                continue;
            if (card.get_previous_sibling() !== previous) {
                if (previous)
                    this._strip.set_child_above_sibling(card, previous);
                else
                    this._strip.set_child_below_sibling(card, null);
            }
            previous = card;
        }
        this.refreshAges();
        this._filter();
        // A new copy may hold the words searched for too.
        if (this._query)
            this._search(this._query);
    }

    /** Shows the cards of the items that match `kind` and `query`, drawing those not drawn yet. */
    _filter() {
        const items = this._all
            .filter(item => !this._kind || item.kind === this._kind)
            .filter(item => matches(item, this._query, this._found));
        this._shown = items.slice(0, MAX_CARDS);
        this._selected = Math.min(this._selected, Math.max(0, this._shown.length - 1));
        const ids = new Set(this._shown.map(item => item.id));
        for (const [id, card] of this._cards)
            card.visible = ids.has(id);

        this._cancelPending();
        this._addCards(FIRST_CARDS, FIRST_CARDS);
        if (this._undrawn()) {
            this._pending = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._addCards(CARDS_PER_IDLE);
                if (this._undrawn())
                    return GLib.SOURCE_CONTINUE;
                this._pending = 0;
                return GLib.SOURCE_REMOVE;
            });
        }

        this._scroll.visible = this._shown.length > 0;
        this._empty.visible = this._shown.length === 0;
        this._updateEmpty();
    }

    /** Whether a shown item still waits for its card. */
    _undrawn() {
        return this._shown.some(item => !this._cards.has(item.id));
    }

    /** Draws up to `count` more of the first `end` shown items, in order. */
    _addCards(count, end = this._shown.length) {
        for (const item of this._shown.slice(0, end)) {
            if (count <= 0)
                break;
            if (this._cards.has(item.id))
                continue;
            const card = this._card(item);
            card._key = JSON.stringify(item);
            // Before the next drawn card of a later item.
            const later = this._all.slice(this._all.indexOf(item) + 1);
            const next = later.map(other => this._cards.get(other.id)).find(Boolean);
            if (next)
                this._strip.insert_child_below(card, next);
            else
                this._strip.add_child(card);
            this._cards.set(item.id, card);
            count--;
        }
        this._syncSelection();
    }

    /** Stops drawing the rest of the cards in idle time. */
    _cancelPending() {
        if (this._pending)
            GLib.source_remove(this._pending);
        this._pending = 0;
    }

    /** Why there are no cards: shared screen, no match, history off, or nothing yet. */
    _updateEmpty() {
        const searching = this._query || this._kind;
        if (this._hidden) {
            this._emptyIcon.gicon = icon('isle-clipboard');
            this._emptyTitle.text = 'Oculto mientras compartes la pantalla';
            this._emptyHint.text = 'Tu portapapeles vuelve a mostrarse cuando dejas de compartir';
        } else if (searching) {
            this._emptyIcon.gicon = icon('isle-search');
            this._emptyTitle.text = 'No se encontró nada';
            this._emptyHint.text = 'Prueba otras palabras u otro filtro';
        } else if (this._off) {
            this._emptyIcon.gicon = icon('isle-clipboard');
            this._emptyTitle.text = 'El historial del portapapeles está desactivado';
            this._emptyHint.text = 'Turn it on in Isle’s settings';
        } else {
            this._emptyIcon.gicon = icon('isle-clipboard');
            this._emptyTitle.text = 'Aún no has copiado nada';
            this._emptyHint.text = 'Aquí aparecen el texto, los enlaces, las imágenes y los archivos que copies';
        }
    }

    // Keyboard

    /** Whether the keyboard drives the selection, which then shows. */
    set keyboard(keyboard) {
        this._keyboard = keyboard;
        this._syncSelection();
    }

    /** Moves the keyboard selection by `step` cards. */
    moveSelection(step) {
        if (this._shown.length === 0)
            return;
        this._selected = Math.min(this._shown.length - 1, Math.max(0, this._selected + step));
        // Arrowing faster than the cards are drawn.
        this._addCards(Infinity, this._selected + 1);
        // Keep the selected card in view.
        // Rows just drawn have no position yet; all are the same height.
        const first = this._cards.get(this._shown[0].id);
        const spacing = this._strip.get_theme_node().get_length('spacing');
        const height = first.height;
        const y = this._selected * (height + spacing);
        const adjustment = this._scroll.vadjustment;
        if (y < adjustment.value)
            adjustment.ease(y, {duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else if (y + height > adjustment.value + adjustment.page_size)
            adjustment.ease(y + height - adjustment.page_size, {duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    /** Chooses the selected card, as Enter does. */
    activateSelected() {
        // Enter typed right after the words: on what they find.
        if (this._destroyed)
            return;
        if (this._searching) {
            this._searching.then(() => this.activateSelected());
            return;
        }
        const item = this._shown[this._selected];
        if (item)
            this.emit('activated', item, true);
    }

    /** Marks the selected card, only while the keyboard is in use. */
    _syncSelection() {
        const selected = this._keyboard ? this._cards.get(this._shown[this._selected]?.id) : null;
        for (const card of this._cards.values()) {
            if (card === selected)
                card.add_style_pseudo_class('selected');
            else
                card.remove_style_pseudo_class('selected');
        }
    }

    /** Any wheel direction moves the list, once it overflows. */
    _onScroll(event) {
        const adjustment = this._scroll.vadjustment;
        if (adjustment.upper <= adjustment.page_size)
            return Clutter.EVENT_PROPAGATE;
        let delta = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            delta = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            delta = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            break;
        }
        }
        adjustment.value += delta * adjustment.step_increment * 1.5;
        return Clutter.EVENT_STOP;
    }

    // Cards

    /** The row, hover actions and a feedback layer, stacked. */
    _card(item) {
        const card = new St.Widget({
            style_class: `isle-clip isle-clip-${item.kind}`,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_expand: false,
            // Long text must not spill out of the card.
            clip_to_allocation: true,
        });
        card.set_pivot_point(0.5, 0.5);
        card.add_child(this._row(item, card));
        const actions = this._actions(item, card);
        card.add_child(actions);

        const feedback = new St.BoxLayout({
            style_class: 'isle-clip-feedback',
            x_expand: true,
            y_expand: true,
            opacity: 0,
            visible: false,
        });
        const feedbackBox = new St.BoxLayout({x_expand: true, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        card._feedbackIcon = new St.Icon({icon_size: 14, y_align: Clutter.ActorAlign.CENTER});
        card._feedbackLabel = label('', 'isle-clip-feedback-label', {y_align: Clutter.ActorAlign.CENTER});
        feedbackBox.add_child(card._feedbackIcon);
        feedbackBox.add_child(card._feedbackLabel);
        feedback.add_child(feedbackBox);
        card.add_child(feedback);
        card._feedback = feedback;

        card.connect('notify::hover', () => actions.ease({opacity: card.hover ? 255 : 0, duration: 120}));
        card.connect('button-release-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;
            this._selected = this._shown.findIndex(shown => shown.id === item.id);
            this._syncSelection();
            this.emit('activated', item, false);
            return Clutter.EVENT_STOP;
        });
        card._item = item;
        // The list redrew (e.g. the item was pinned) while it flashed.
        if (this._flashing?.id === item.id && Date.now() < this._flashing.until)
            this._showFlash(card, false);
        return card;
    }

    /** Shows "Copied" (or similar) over the card for a moment. */
    flash(item, iconName, text) {
        this._flashing = {id: item.id, iconName, text, until: Date.now() + FEEDBACK_MS};
        const card = this._cards.get(item.id);
        if (card)
            this._showFlash(card, true);
    }

    /** Without `fadeIn` it shows at once: a redrawn card picks up a flash already running. */
    _showFlash(card, fadeIn) {
        const {iconName, text, until} = this._flashing;
        card._feedbackIcon.gicon = icon(iconName);
        card._feedbackLabel.text = text;
        const feedback = card._feedback;
        feedback.remove_all_transitions();
        feedback.show();
        feedback.opacity = fadeIn ? 0 : 255;
        feedback.ease({
            opacity: 255,
            duration: fadeIn ? 120 : 0,
            onComplete: () => feedback.ease({
                opacity: 0,
                delay: Math.max(0, until - Date.now()),
                duration: 200,
                onComplete: () => feedback.hide(),
            }),
        });
    }

    /** Pin, a thumbnail or icon, one line of what was copied, and its age. */
    _row(item, card) {
        const row = new St.BoxLayout({style_class: 'isle-clip-row', x_expand: true, y_expand: true});
        const center = {y_align: Clutter.ActorAlign.CENTER};
        if (item.pinned)
            row.add_child(new St.Icon({gicon: icon('isle-pin-fill'), icon_size: 11, style_class: 'isle-clip-pin', ...center}));

        const app = appFor(item.app_id);
        let text;
        switch (item.kind) {
        case 'image': {
            const thumb = new St.Widget({style_class: 'isle-clip-row-thumb', ...center});
            if (item.thumb)
                thumb.style = `background-image: url("${GLib.filename_to_uri(item.thumb, null).replace(/"/g, '%22')}");`;
            row.add_child(thumb);
            text = item.width && item.height ? `Imagen · ${item.width}×${item.height}` : 'Imagen';
            break;
        }
        case 'files': {
            const names = item.preview.split('\n');
            const [type] = Gio.content_type_guess(names[0], null);
            row.add_child(new St.Icon({gicon: Gio.content_type_get_icon(type), icon_size: 16, ...center}));
            text = names.length > 1 ? `${names[0]}  +${names.length - 1} más` : names[0];
            break;
        }
        case 'link': {
            const link = item.preview.trim();
            row.add_child(new St.Icon({gicon: app?.get_icon() ?? icon('isle-link'), icon_size: 16, ...center}));
            text = link.replace(/^https?:\/\//i, '');
            break;
        }
        default:
            row.add_child(new St.Icon({gicon: app?.get_icon() ?? icon('isle-clipboard'), icon_size: 16, ...center}));
            text = item.preview.replace(/\s+/g, ' ').trim().slice(0, 200);
        }
        const code = item.kind === 'text' && CODE_PATTERN.test(item.preview);
        const preview = label(text, code ? 'isle-clip-text isle-clip-code' : 'isle-clip-text', {x_expand: true, ...center});
        preview.clutter_text.ellipsize = item.kind === 'files' ? Pango.EllipsizeMode.MIDDLE : Pango.EllipsizeMode.END;
        row.add_child(preview);

        const age = GLib.DateTime.new_from_unix_local(Math.floor(item.at_ms / 1000));
        const ageLabel = label(Format.ago(age), 'isle-clip-age', center);
        card._age = [ageLabel, age];
        row.add_child(ageLabel);
        return row;
    }

    // Puts a copy of a clipboard image on the shelf under a readable name: the history's file goes when
    // the item is pruned, the copy stays until taken off the shelf (isled then deletes it).
    _shelveImage(item) {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'isle', 'shelf']);
        GLib.mkdir_with_parents(dir, 0o700);
        const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d at %H.%M.%S');
        // Two in the same second get " 2", " 3"…: never one over another.
        const attempt = n => {
            const target = Gio.File.new_for_path(GLib.build_filenamev([dir, `Imagen del portapapeles ${stamp}${n > 1 ? ` ${n}` : ''}.png`]));
            Gio.File.new_for_path(item.image).copy_async(target, Gio.FileCopyFlags.NONE,
                GLib.PRIORITY_DEFAULT, null, null, (source, result) => {
                    try {
                        source.copy_finish(result);
                        this._daemon.call('shelf', 'Add', [target.get_uri()]);
                    } catch (e) {
                        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS) && n < 50)
                            attempt(n + 1);
                        else
                            console.warn(`Isle: could not put the image on the shelf: ${e.message}`);
                    }
                });
        };
        attempt(1);
    }

    /** Pin, a hand-off and × at the row's right end, over its age, shown on hover. */
    _actions(item, card) {
        const actions = new St.BoxLayout({
            style_class: 'isle-clip-actions',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
        });
        // St.Button stops the release it handles, so a click on one of these
        // never also copies the card.
        const button = (iconName, accessibleName, onClick) =>
            iconButton(iconName, 'isle-clip-action', onClick, {size: 11, accessibleName});

        // Pinned items stay at the front and survive Clear all.
        actions.add_child(button(item.pinned ? 'isle-pin-fill' : 'isle-pin',
            item.pinned ? 'Desfijar' : 'Fijar',
            () => {
                const pinned = (this._daemon.state.clipboard ?? []).filter(other => other.pinned).length;
                if (!item.pinned && pinned >= MAX_PINNED) {
                    this.flash(item, 'isle-pin', 'Fijados llenos · desfija uno');
                    return;
                }
                this._daemon.call('clipboard', 'SetPinned', item.id, !item.pinned);
                if (!item.pinned)
                    this.flash(item, 'isle-pin-fill', 'Fijado');
            }));

        if (item.kind === 'image' || item.kind === 'files') {
            actions.add_child(button('isle-shelf', 'Añadir a la pestaña Archivos', () => {
                const shelf = this._daemon.state.shelf ?? [];
                const fresh = item.kind === 'image'
                    ? 1
                    : item.uris.filter(uri => !shelf.some(file => file.uri === uri)).length;
                if (shelf.length + fresh > SHELF_CAPACITY) {
                    this.flash(item, 'isle-shelf', 'Archivos está lleno');
                    return;
                }
                if (item.kind === 'image')
                    this._shelveImage(item);
                else
                    this._daemon.call('shelf', 'Add', item.uris);
                this.flash(item, 'isle-shelf', 'Añadido a Archivos');
            }));
        } else {
            actions.add_child(button('isle-tasks', 'Añadir a Recordatorios', () => {
                const title = item.preview.split('\n').find(line => line.trim())?.trim().slice(0, 120);
                if (!title)
                    return;
                this._daemon.call('todo', 'Add', title);
                this.flash(item, 'isle-tasks', 'Añadido a Recordatorios');
            }));
        }

        actions.add_child(button('isle-close-symbolic', 'Quitar', () => {
            // Removed at once; the card shrinks away until the list redraws.
            this._daemon.call('clipboard', 'Remove', item.id);
            card._removed = true;
            card.reactive = false;
            card.ease({opacity: 0, scale_x: 0.9, scale_y: 0.9, duration: 150});
        }));
        return actions;
    }
});
