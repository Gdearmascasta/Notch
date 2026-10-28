// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// A call in any app (WhatsApp, Telegram, Meet in a browser…): an app holding the microphone,
// the window it runs in, and the microphone's mute. Event driven, like privacy.js.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

import {LEVEL_METERS} from './privacy.js';

/** The microphone must be held this long to count: sites open it briefly to ask for permission. */
const START_DELAY_MS = 2000;
/** A tab named after a call service only names the call this early on (µs), while it is the call's tab. */
const SERVICE_GRACE_US = 15 * 1000 * 1000;
/** A call outlasts the microphone closing this long, as apps reopen it to switch devices. */
const END_DELAY_MS = 4000;
/** Isle's own recordings: the voice assistant listening. */
const OWN_APP_ID = 'io.github.zickrian.isle';
/** Apps that record rather than call, matched in their names. */
const RECORDERS = ['obs', 'audacity', 'tenacity', 'recorder', 'kooha', 'kdenlive', 'ardour'];
/** The icon Gvc gives a stream that names none. */
const DEFAULT_STREAM_ICON = 'audio-input-microphone';

/** A window's title settles this soon (ms) after it appears or changes, before the call's window is looked at again. */
const RECHECK_MS = 500;
/** A tab moving: its old window stops showing the call and another starts within this long (µs) of it. */
const MOVE_WITHIN_US = 2 * 1000000;
/** Call services named in window titles, for calls in a browser. */
const SERVICES = [
    [/google meet|\bmeet\b/i, 'Google Meet'],
    [/whatsapp/i, 'WhatsApp'],
    [/telegram/i, 'Telegram'],
    [/discord/i, 'Discord'],
    [/zoom/i, 'Zoom'],
    [/microsoft teams|\bteams\b/i, 'Microsoft Teams'],
    [/jitsi/i, 'Jitsi Meet'],
    [/slack/i, 'Slack'],
    [/messenger/i, 'Messenger'],
    [/signal/i, 'Signal'],
    [/skype/i, 'Skype'],
    [/webex/i, 'Webex'],
];

/** Browsers, whose tabs hold web calls (Meet, Zoom, Teams on the web...). */
const BROWSERS = /chrom|firefox|brave|edge|vivaldi|opera|epiphany|librewolf|zen/i;

/** The call service a window title names, or null. */
function serviceOf(title) {
    return SERVICES.find(([pattern]) => pattern.test(title ?? ''))?.[1] ?? null;
}

/** The lower-case names a stream goes by: its app's id, name and icon. */
function streamKeys(stream) {
    const iconName = stream.get_icon_name();
    return [stream.get_application_id(), stream.get_name(), iconName === DEFAULT_STREAM_ICON ? null : iconName]
        .filter(Boolean)
        .map(key => key.toLowerCase().replace(/\.desktop$/, ''));
}

/** Whether `app` is the one a stream with `keys` comes from ("Google Chrome", "firefox_firefox"…). */
function appMatches(app, keys) {
    const executable = app.get_app_info()?.get_executable();
    const names = [app.get_id()?.replace(/\.desktop$/, ''), app.get_name(), executable && GLib.path_get_basename(executable)]
        .filter(Boolean)
        .map(name => name.toLowerCase());
    return keys.some(key => names.some(name =>
        key === name || (name.length >= 4 && key.includes(name)) || (key.length >= 4 && name.includes(key))));
}

/** Signals: `changed` (the call, its window or the mute), `started`. */
export class CallMonitor extends Signals.EventEmitter {
    /** Follows the mixer's streams, the default microphone and the call-activity setting. */
    constructor(privacy, settings) {
        super();
        this._privacy = privacy;
        this._settings = settings;
        this._mixer = getMixerControl();
        this._appSystem = Shell.AppSystem.get_default();
        this.active = false;
        /** GLib monotonic time (µs) when the call started. */
        this.since = 0;
        this.app = null;
        this.window = null;
        /** The call's microphone stream. */
        this._stream = null;
        /** The call service the call's window named, kept for the whole call. */
        this._service = null;
        this._streamName = null;
        this._heldSince = 0;
        this._timeouts = {start: 0, end: 0, recheck: 0, standIn: 0};
        /** The call's window is a guess made as its own closed, until its tab shows where it went. */
        this._standIn = false;
        this._source = null;
        this._sourceIds = [];
        this._windowIds = [];
        /** Each window watched during the call: {ids, gained, gainedAt}, the service its title came to name, and when. */
        this._watched = new Map();
        /** When (µs) the call's window last stopped showing the call: closed, or another tab in front. */
        this._lostAt = 0;
        this._windowNamed = false;

        this._mixerIds = [
            ...['stream-added', 'stream-removed'].map(signal => this._mixer.connect(signal, () => this._sync())),
            ...['default-source-changed', 'state-changed'].map(signal => this._mixer.connect(signal, () => this._watchSource())),
        ];
        this._settingsId = settings.connect('changed::call-activity', () => this._sync());
        // A tab torn off into a window of its own (the call's, say) comes as a new window, its title a moment later.
        this._windowCreatedId = global.display.connect('window-created', (_display, window) => this._watchWindow(window, true));
        // The camera makes it a video call; screen sharing hides the preview.
        this._privacyId = privacy.connect('changed', () => this._changed());
        this._watchSource();
        this._sync();
    }

    /** Whether the camera is on too. */
    get video() {
        return this.active && this._privacy.camera;
    }

    /** Whether the microphone (GNOME's default input) is muted, for every app. */
    get muted() {
        return this._source?.is_muted ?? false;
    }

    /** Mutes or unmutes the microphone from the call's button. */
    toggleMuted() {
        this._source?.change_is_muted(!this.muted);
    }

    /** Whether an app besides the call's is using the microphone, which then still gets its dot. */
    get othersRecording() {
        if (!this.active)
            return false;
        return this._mixer.get_source_outputs().some(stream =>
            !LEVEL_METERS.includes(stream.get_application_id()) && stream !== this._stream &&
            !(this.app && appMatches(this.app, streamKeys(stream))));
    }

    /** The call's service ("Google Meet") once its window named one, else its app's name. */
    get name() {
        return this._service ?? this.app?.get_name() ?? this._streamName ?? 'Llamada';
    }

    /** The call app's icon, or null when the app is unknown. */
    get gicon() {
        return this.app?.get_icon() ?? null;
    }

    /** Brings the call's window, or else its app, to the front. */
    raise() {
        if (this.window)
            Main.activateWindow(this.window);
        else
            this.app?.activate();
    }

    /** Only a running call has anything to redraw. */
    _changed() {
        if (this.active)
            this.emit('changed');
    }

    /** The microphone stream of a call, or null. */
    _callStream() {
        if (!this._settings.get_boolean('call-activity'))
            return null;
        return this._mixer.get_source_outputs().find(stream => {
            const appId = stream.get_application_id();
            if (LEVEL_METERS.includes(appId) || appId === OWN_APP_ID)
                return false;
            return !streamKeys(stream).some(key => RECORDERS.some(recorder => key.includes(recorder)));
        }) ?? null;
    }

    /** Starts a call once the microphone is held long enough, and ends it a while after it is let go. */
    _sync() {
        const stream = this._callStream();
        this._stream = stream;
        if (stream) {
            this._cancel('end');
            if (this.active) {
                // Another app may have started or stopped recording too.
                this._identify(stream);
                this.emit('changed');
            } else if (!this._timeouts.start) {
                this._heldSince = GLib.get_monotonic_time();
                this._later('start', START_DELAY_MS, () => this._begin());
            }
            return;
        }
        this._cancel('start');
        // Turned off in the settings, it ends at once.
        if (this.active && !this._timeouts.end)
            this._later('end', this._settings.get_boolean('call-activity') ? END_DELAY_MS : 0, () => this._end());
    }

    /** The microphone is still held after the delay: the call is on. */
    _begin() {
        const stream = this._callStream();
        if (!stream)
            return;
        this.active = true;
        this.since = this._heldSince;
        global.display.list_all_windows().forEach(window => this._watchWindow(window));
        this._identify(stream);
        this.emit('started');
        this.emit('changed');
    }

    /** Clears the call and its window. */
    _end() {
        this._cancel('recheck');
        this._cancel('standIn');
        this._standIn = false;
        this._unwatchWindows();
        this.active = false;
        this.since = 0;
        this._lostAt = 0;
        this.app = null;
        this._streamName = null;
        this._setWindow(null);
        this._service = null;
        this.emit('changed');
    }

    /** Finds the app and window of `stream`; returns whether they changed. */
    _identify(stream) {
        const keys = streamKeys(stream);
        const app = this._appSystem.get_running().find(candidate => appMatches(candidate, keys)) ?? null;
        this._streamName = stream.get_name() || null;
        const service = this._service;
        const window = this._chooseWindow(app);
        if (app === this.app && window === this.window && service === this._service)
            return false;
        this.app = app;
        this._setWindow(window);
        return true;
    }

    // The call keeps the window it was found in: one titled after a call service, else the app's window
    // in front when it began. A guess gives way to a service's window; switching tabs moves nothing.
    _chooseWindow(app, leaving = null) {
        const usable = window => window !== leaving && window.get_window_type() === Meta.WindowType.NORMAL &&
            !window.is_skip_taskbar();
        // Most recently used first.
        const appWindows = app ? app.get_windows().filter(usable) : [];
        // A browser's web app (Meet, WhatsApp Web) may run in a window the shell files under another app,
        // but always of the same browser: a Meet tab in Firefox is not a call in Chrome.
        const family = app ? appWindows.map(window => (window.get_wm_class() ?? '').match(BROWSERS)?.[0]).find(Boolean) : null;
        const browserWindows = !app || family
            ? global.display.list_all_windows().filter(window => usable(window) &&
                (family ? (window.get_wm_class() ?? '').toLowerCase().includes(family.toLowerCase())
                    : BROWSERS.test(window.get_wm_class() ?? '')))
            : [];
        const candidates = [...new Set([...appWindows, ...browserWindows])];
        const current = candidates.includes(this.window) ? this.window : null;
        // Kept while it still shows the call; else a window whose title came to show it as the call left this one
        // (its tab moved there). Never one that names the service at another time (Meet's home page, "Quick meet").
        const arrived = window => {
            const watched = this._watched.get(window);
            return window !== current && this._lostAt > 0 && watched?.gained === this._service &&
                Math.abs(watched.gainedAt - this._lostAt) <= MOVE_WITHIN_US &&
                serviceOf(window.get_title()) === this._service;
        };
        if (current && this._service) {
            // A stand-in picked as the call's window closed gives way to the window its tab really went to.
            const left = serviceOf(current.get_title()) !== this._service || this._standIn;
            const moved = left && candidates.find(arrived);
            if (moved)
                this._standIn = false;
            return moved || current;
        }
        // A known call keeps its service: the window its tab just went to, else one showing it (not WhatsApp's
        // for a Meet call), a stand-in until the tab's own window shows up.
        const went = this._service && candidates.find(arrived);
        if (went)
            return went;
        const named = candidates.find(window => this._service ? serviceOf(window.get_title()) === this._service
            : serviceOf(window.get_title()));
        if (named) {
            this._service ??= serviceOf(named.get_title());
            return named;
        }
        // Without a known app only a browser's call tab will do (not an editor showing "signal.rs").
        return current ?? appWindows.find(window => window.has_focus()) ?? appWindows[0] ?? null;
    }

    /** Follows the call's window: closed, retitled or minimized. */
    _setWindow(window) {
        if (window === this.window)
            return;
        this._windowIds.forEach(id => this.window.disconnect(id));
        this._windowIds = [];
        this.window = window;
        if (!window)
            return;
        this._windowNamed = Boolean(this._service) && serviceOf(window.get_title()) === this._service;
        this._windowIds = [
            // Closed: another window showing the call (the service is kept, so later moves are still followed).
            window.connect('unmanaged', () => {
                this._lostAt = GLib.get_monotonic_time();
                const next = this._chooseWindow(this.app, window);
                // Not one its tab just went to: a stand-in, for as long as a move can still come.
                const watched = next && this._watched.get(next);
                this._standIn = Boolean(next && this._service) && !(watched?.gained === this._service &&
                    Math.abs(watched.gainedAt - this._lostAt) <= MOVE_WITHIN_US);
                if (this._standIn)
                    this._later('standIn', MOVE_WITHIN_US / 1000, () => (this._standIn = false));
                this._setWindow(next);
                this._changed();
            }),
            // The call's tab came to the front: now the window is known for sure.
            window.connect('notify::title', () => {
                if (GLib.get_monotonic_time() - this.since < SERVICE_GRACE_US)
                    this._service ??= serviceOf(window.get_title());
                // Its tab leaving: the moment a window gaining it must come close to (see `_chooseWindow`).
                const named = Boolean(this._service) && serviceOf(window.get_title()) === this._service;
                if (this._windowNamed && !named)
                    this._lostAt = GLib.get_monotonic_time();
                this._windowNamed = named;
                this._recheckWindow();
                this._changed();
            }),
            window.connect('notify::minimized', () => this._changed()),
        ];
    }

    /** Follows a window's title during the call, noting the service it comes to name (a call's tab arriving).
     * One `created` during the call came with the tab when its title already names it (X11 sets it first). */
    _watchWindow(window, created = false) {
        if (!this.active || this._watched.has(window) || window.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        const entry = {gained: created ? serviceOf(window.get_title()) : null, gainedAt: GLib.get_monotonic_time()};
        entry.ids = [
            window.connect('notify::title', () => {
                // Any new title naming a service (another Meet page too): the call's tab may have come.
                const now = serviceOf(window.get_title());
                entry.gained = now;
                entry.gainedAt = GLib.get_monotonic_time();
                // Only a title naming the call's service can move it; others' titles (a terminal's spinner) can't.
                if (now && now === this._service)
                    this._recheckWindow();
            }),
            window.connect('unmanaged', () => {
                entry.ids.forEach(id => window.disconnect(id));
                this._watched.delete(window);
            }),
        ];
        this._watched.set(window, entry);
        if (entry.gained)
            this._recheckWindow();
    }

    /** Stops following the windows' titles. */
    _unwatchWindows() {
        for (const [window, {ids}] of this._watched)
            ids.forEach(id => window.disconnect(id));
        this._watched.clear();
    }

    /** Shortly after a title change, the window that shows a known call, if another now. */
    _recheckWindow() {
        if (!this.active || !this._service || this._timeouts.recheck)
            return;
        this._later('recheck', RECHECK_MS, () => {
            if (!this.active)
                return;
            const window = this._chooseWindow(this.app);
            if (window && window !== this.window) {
                this._setWindow(window);
                this._changed();
            }
        });
    }

    /** Moves the mute listener to the current default microphone. */
    _watchSource() {
        this._sourceIds.forEach(id => this._source.disconnect(id));
        this._sourceIds = [];
        this._source = this._mixer.get_default_source();
        if (this._source)
            this._sourceIds = [this._source.connect('notify::is-muted', () => this._changed())];
        this._changed();
    }

    /** Runs `callback` once after `ms`, under `name` so it can be cancelled. */
    _later(name, ms, callback) {
        this._timeouts[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts[name] = 0;
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Cancels the pending `start`, `end`, `recheck` or `standIn`, if any. */
    _cancel(name) {
        if (this._timeouts[name]) {
            GLib.source_remove(this._timeouts[name]);
            this._timeouts[name] = 0;
        }
    }

    /** Stops both timers and every listener. */
    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._cancel('start');
        this._cancel('end');
        this._cancel('recheck');
        this._cancel('standIn');
        this._unwatchWindows();
        global.display.disconnect(this._windowCreatedId);
        this._setWindow(null);
        this._sourceIds.forEach(id => this._source.disconnect(id));
        this._mixerIds.forEach(id => this._mixer.disconnect(id));
        this._settings.disconnect(this._settingsId);
        this._privacy.disconnect(this._privacyId);
    }
}
