// Freeform Group Chat — SillyTavern extension (v0.3.0)
//
//  1. Scene tracking (saved per chat): location, time, atmosphere, situation, and a
//     location for each group member. Characters who share a location can interact freely;
//     characters elsewhere can be mentioned but are not physically present.
//  2. On every group generation, injects a scene note into the prompt with all of that,
//     plus trimmed cards for the responder and everyone who is with them.
//  3. Optionally splits the reply into separate messages per character ("Name: ..." lines).

const MODULE = 'freeform_group_chat';
const TAG = '[FreeformGroupChat]';

const defaultSettings = Object.freeze({
    enabled: true,
    useScene: true,         // include the scene info (location, time, ...) in the prompt
    injectCards: true,      // include trimmed cards of the responder and those with them
    cardLimit: 1200,
    depth: 1,
    splitMessages: false,
    instruction: '',
    autoTrack: true,        // ask the model where everyone is after each character message
    trackEvery: 1,          // ...every N character messages
    trackTimeMood: false,   // also let the model update time and atmosphere
});

const defaultScene = Object.freeze({
    location: '',
    places: '',             // comma-separated list of places characters can be in
    time: '',
    atmosphere: '',
    situation: '',
    locations: {},          // avatar filename -> that character's place (picked from a dropdown)
});

// messageId -> extra segments waiting to be added after render
const pendingExtras = new Map();

// ---------- settings (global) ----------

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE]) {
        extensionSettings[MODULE] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE], key)) {
            extensionSettings[MODULE][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE];
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// ---------- scene (per chat, stored in chat metadata) ----------

function getScene() {
    const md = SillyTavern.getContext().chatMetadata;
    if (!md[MODULE]) {
        md[MODULE] = structuredClone(defaultScene);
    }
    for (const key of Object.keys(defaultScene)) {
        if (!Object.hasOwn(md[MODULE], key)) {
            md[MODULE][key] = structuredClone(defaultScene[key]);
        }
    }
    return md[MODULE];
}

let sceneSaveTimer = null;
function saveScene() {
    clearTimeout(sceneSaveTimer);
    sceneSaveTimer = setTimeout(async () => {
        try {
            await SillyTavern.getContext().saveMetadata();
        } catch (err) {
            console.error(TAG, 'saving scene failed', err);
        }
    }, 600);
}

// ---------- group helpers ----------

function getActiveGroup() {
    const ctx = SillyTavern.getContext();
    if (!ctx.groupId) return null;
    return ctx.groups.find(g => String(g.id) === String(ctx.groupId)) ?? null;
}

function getGroupMembers() {
    const ctx = SillyTavern.getContext();
    const group = getActiveGroup();
    if (!group) return [];
    const disabled = new Set(group.disabled_members ?? []);
    return (group.members ?? [])
        .filter(avatar => !disabled.has(avatar))
        .map(avatar => ctx.characters.find(c => c.avatar === avatar))
        .filter(Boolean);
}

const norm = s => (s ?? '').trim().toLowerCase();

/** A character's effective location: their own, else the scene's default. */
function locationOf(character, scene) {
    return (scene.locations[character.avatar] ?? '').trim() || scene.location.trim();
}

/** Two characters are together if their effective locations match (or neither is set). */
function areTogether(a, b, scene) {
    return norm(locationOf(a, scene)) === norm(locationOf(b, scene));
}

function trimTo(text, limit) {
    text = (text ?? '').trim();
    if (text.length <= limit) return text;
    return text.slice(0, limit).trimEnd() + '…';
}

function buildCard(character, userName, limit) {
    const parts = [];
    const desc = character.description ?? character.data?.description;
    const pers = character.personality ?? character.data?.personality;
    const scen = character.scenario ?? character.data?.scenario;
    if (desc) parts.push(desc);
    if (pers) parts.push(`Personality: ${pers}`);
    if (scen) parts.push(`Scenario: ${scen}`);

    let card = parts.join('\n');
    card = card.replace(/\{\{char\}\}/gi, character.name).replace(/\{\{user\}\}/gi, userName);
    return trimTo(card, limit);
}

// ---------- prompt injection ----------

function buildSceneNote(settings) {
    const ctx = SillyTavern.getContext();
    const members = getGroupMembers();
    if (members.length < 2) return '';

    const scene = getScene();
    const userName = ctx.name1 || 'the user';
    const speaker = members.find(m => m.name === ctx.name2) ?? null;
    const withSpeaker = speaker ? members.filter(m => m !== speaker && areTogether(m, speaker, scene)) : members;
    const elsewhere = speaker ? members.filter(m => m !== speaker && !areTogether(m, speaker, scene)) : [];

    const lines = [];
    lines.push('[Freeform group scene.');

    if (settings.useScene) {
        const setting = [];
        if (scene.location.trim()) setting.push(`Location: ${scene.location.trim()}`);
        if (scene.time.trim()) setting.push(`Time: ${scene.time.trim()}`);
        if (scene.atmosphere.trim()) setting.push(`Atmosphere: ${scene.atmosphere.trim()}`);
        if (setting.length) lines.push(setting.join(' | '));
        if (scene.situation.trim()) lines.push(`Current situation: ${scene.situation.trim()}`);

        const anyLocation = members.some(m => locationOf(m, scene));
        if (anyLocation) {
            lines.push('Where everyone is:');
            for (const m of members) {
                lines.push(`- ${m.name}: ${locationOf(m, scene) || 'unspecified'}`);
            }
        }
    }

    if (speaker) {
        lines.push(`Responding now: ${speaker.name}.`);
        if (withSpeaker.length) {
            lines.push(`Together with ${speaker.name}: ${withSpeaker.map(m => m.name).join(', ')}.`);
        }
        if (elsewhere.length) {
            lines.push(`Elsewhere (not present with ${speaker.name}): ${elsewhere.map(m => m.name).join(', ')}.`);
        }
    }

    lines.push(
        'This is a living scene, not a strict turn order. The responding character may notice, ' +
        'address, mention, or react to anyone who is physically together with them, and may include ' +
        'short lines or actions from those characters when it flows naturally. Only include others ' +
        'when the moment calls for it. ' +
        (elsewhere.length
            ? 'Characters who are elsewhere can be talked about, remembered, or contacted, but must not ' +
              'speak or act in the scene unless the story brings them there. '
            : '') +
        `Never write dialogue or actions for ${userName}. Keep every character true to their own card.`,
    );

    if (settings.splitMessages) {
        lines.push(
            'When a different character speaks or acts, start a new paragraph with their name and a ' +
            'colon, like "Name: ..." so it can be attributed correctly.',
        );
    }
    if (settings.instruction.trim()) {
        lines.push(settings.instruction.trim());
    }

    if (settings.injectCards) {
        const carded = speaker ? [speaker, ...withSpeaker] : members;
        lines.push('\nCharacter cards:');
        for (const m of carded) {
            const card = buildCard(m, userName, settings.cardLimit);
            if (card) lines.push(`--- ${m.name} ---\n${card}`);
        }
    }
    lines.push(']');
    return lines.join('\n');
}

function setNote(text, depth) {
    const ctx = SillyTavern.getContext();
    const IN_CHAT = ctx.extension_prompt_types?.IN_CHAT ?? 1;
    const ROLE_SYSTEM = ctx.extension_prompt_roles?.SYSTEM ?? 0;
    ctx.setExtensionPrompt(MODULE, text, IN_CHAT, depth, false, ROLE_SYSTEM);
}

// Called by SillyTavern before every (non-dry-run) generation. Declared in manifest.json.
globalThis.freeformGroupChatInterceptor = async function (chat, contextSize, abort, type) {
    try {
        const settings = getSettings();
        const ctx = SillyTavern.getContext();
        if (!settings.enabled || !ctx.groupId || type === 'quiet') {
            setNote('', settings.depth);
            return;
        }
        setNote(buildSceneNote(settings), settings.depth);
    } catch (err) {
        console.error(TAG, 'interceptor failed', err);
    }
};

// ---------- optional splitting of replies ----------

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitReply(text, members) {
    if (members.length < 2) return null;
    const byLower = new Map(members.map(m => [m.name.toLowerCase(), m]));
    const alternation = [...byLower.keys()]
        .sort((a, b) => b.length - a.length)
        .map(escapeRegex)
        .join('|');
    const labelRe = new RegExp(`^\\s*(?:\\*\\*|\\*|_)?(${alternation})(?:\\*\\*|\\*|_)?\\s*:\\s*`, 'i');

    const segments = [];
    let current = null;
    for (const line of text.split('\n')) {
        const m = line.match(labelRe);
        if (m) {
            current = { character: byLower.get(m[1].toLowerCase()), text: line.slice(m[0].length) };
            segments.push(current);
        } else if (current) {
            current.text += '\n' + line;
        } else {
            current = { character: null, text: line };
            segments.push(current);
        }
    }

    const merged = [];
    for (const seg of segments) {
        seg.text = seg.text.trim();
        if (!seg.text) continue;
        const last = merged[merged.length - 1];
        if (last && last.character === seg.character) last.text += '\n\n' + seg.text;
        else merged.push(seg);
    }
    return merged.length > 1 ? merged : null;
}

function onMessageReceived(messageId, type) {
    try {
        const settings = getSettings();
        const ctx = SillyTavern.getContext();
        if (!settings.enabled || !settings.splitMessages || !ctx.groupId) return;
        if (type === 'impersonate' || type === 'quiet') return;

        const message = ctx.chat[messageId];
        if (!message || message.is_user || message.is_system) return;

        const members = getGroupMembers();
        const segments = splitReply(message.mes ?? '', members);
        if (!segments) return;

        const original = members.find(m => m.name === message.name);
        const [first, ...rest] = segments;
        const firstChar = first.character ?? original;
        message.mes = first.text;
        if (firstChar) {
            message.name = firstChar.name;
            message.original_avatar = firstChar.avatar;
        }

        const extras = rest
            .map(seg => seg.character ? seg : { character: original, text: seg.text })
            .filter(seg => seg.character);
        if (extras.length) pendingExtras.set(Number(messageId), extras);
    } catch (err) {
        console.error(TAG, 'split failed', err);
    }
}

async function onMessageRendered(messageId) {
    const extras = pendingExtras.get(Number(messageId));
    if (!extras) return;
    pendingExtras.delete(Number(messageId));

    const ctx = SillyTavern.getContext();
    const moment = SillyTavern.libs?.moment;
    for (const seg of extras) {
        const msg = {
            name: seg.character.name,
            is_user: false,
            is_system: false,
            send_date: moment ? moment().format('LL LT') : new Date().toISOString(),
            mes: seg.text,
            original_avatar: seg.character.avatar,
            extra: {},
        };
        ctx.chat.push(msg);
        ctx.addOneMessage(msg);
    }
    await ctx.saveChat();
}

// ---------- automatic scene tracking (uses the model) ----------

let trackBusy = false;
let trackCounter = 0;

function knownPlaces(scene) {
    const out = [];
    const seen = new Set();
    const add = p => {
        p = (p ?? '').trim();
        if (p && !seen.has(norm(p))) { seen.add(norm(p)); out.push(p); }
    };
    add(scene.location);
    String(scene.places).split(',').forEach(add);
    return out;
}

/** Map the model's wording onto an existing place; register a new place if it really is new. */
function resolvePlace(raw, scene) {
    const name = String(raw ?? '').trim();
    if (!name || /^(unknown|unspecified|n\/a|none|same|unchanged)$/i.test(name)) return null;

    const known = knownPlaces(scene);
    const exact = known.find(p => norm(p) === norm(name));
    if (exact) return exact;

    const loose = known.filter(p => norm(p).includes(norm(name)) || norm(name).includes(norm(p)));
    if (loose.length === 1) return loose[0];

    const list = String(scene.places).split(',').map(s => s.trim()).filter(Boolean);
    list.push(name);
    scene.places = list.join(', ');
    return name;
}

function extractJson(text) {
    const s = String(text ?? '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(s.slice(start, end + 1));
    } catch {
        return null;
    }
}

async function updateSceneFromChat(manual = false) {
    const ctx = SillyTavern.getContext();
    const settings = getSettings();
    if (trackBusy || !ctx.groupId) return;
    const members = getGroupMembers();
    if (members.length < 2) {
        if (manual) toastr.info('Open a group chat with at least two members.');
        return;
    }

    trackBusy = true;
    try {
        const scene = getScene();
        const userName = ctx.name1 || 'User';
        const recent = ctx.chat
            .filter(m => !m.is_system)
            .slice(-8)
            .map(m => `${m.is_user ? userName : m.name}: ${trimTo(m.mes, 700)}`)
            .join('\n\n');
        const known = knownPlaces(scene);
        const current = members.map(m => `- ${m.name}: ${locationOf(m, scene) || 'unknown'}`).join('\n');

        const systemPrompt =
            'You are a scene tracker for a roleplay. You read recent messages and report where each ' +
            'character physically is. Reply with a single JSON object and nothing else.';
        const prompt = [
            known.length
                ? `Known places: ${known.join(', ')}. Reuse these exact names whenever a character is in one of them. Only use a new short place name if a character is somewhere new.`
                : 'No places are defined yet. Use short, consistent place names.',
            `Characters: ${members.map(m => m.name).join(', ')}`,
            `Current positions:\n${current}`,
            `Recent messages:\n${recent}`,
            'Task: report where each character is NOW. Keep a character at their current position unless ' +
            'the messages clearly show they moved, left, or arrived somewhere. If someone left for an unnamed ' +
            'destination, use a short descriptive name (for example "On the road").',
            settings.trackTimeMood
                ? 'Also give the current time of day and a short mood/atmosphere (use an empty string if unclear).'
                : 'Leave "time" and "atmosphere" as empty strings.',
            'Format: {"characters": {"<name>": "<place>"}, "time": "", "atmosphere": ""}',
        ].join('\n\n');

        const raw = await ctx.generateRaw({ prompt, systemPrompt });
        const data = extractJson(raw);
        if (!data || typeof data.characters !== 'object' || !data.characters) {
            if (manual) toastr.warning('The model did not return a usable scene update.');
            return;
        }

        const byName = new Map(Object.entries(data.characters).map(([k, v]) => [norm(k), v]));
        for (const member of members) {
            const place = resolvePlace(byName.get(norm(member.name)), scene);
            if (place) scene.locations[member.avatar] = place;
        }
        if (settings.trackTimeMood) {
            if (typeof data.time === 'string' && data.time.trim()) scene.time = data.time.trim();
            if (typeof data.atmosphere === 'string' && data.atmosphere.trim()) scene.atmosphere = data.atmosphere.trim();
        }

        saveScene();
        renderScene();
        if (manual) toastr.success('Scene updated.');
    } catch (err) {
        console.error(TAG, 'scene tracking failed', err);
        if (manual) toastr.error('Scene update failed (see console).');
    } finally {
        trackBusy = false;
    }
}

function maybeTrack() {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoTrack || !SillyTavern.getContext().groupId) return;
    trackCounter++;
    if (trackCounter % Math.max(1, settings.trackEvery) !== 0) return;
    updateSceneFromChat(false); // intentionally not awaited
}

// ---------- settings + scene UI ----------

function addSettingsUi() {
    const settings = getSettings();
    const html = `
    <div class="ffgc-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Freeform Group Chat</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label"><input id="ffgc_enabled" type="checkbox" />
                    <span>Enable freeform mode in group chats</span></label>
                <label class="checkbox_label"><input id="ffgc_usescene" type="checkbox" />
                    <span>Use scene info (location, time, ...) in the prompt</span></label>
                <label class="checkbox_label"><input id="ffgc_inject" type="checkbox" />
                    <span>Include cards of the responder and whoever is with them</span></label>
                <label class="checkbox_label"><input id="ffgc_split" type="checkbox" />
                    <span>Split "Name: ..." lines into separate messages</span></label>

                <hr />
                <b>Scene (saved per chat)</b>
                <label class="checkbox_label"><input id="ffgc_autotrack" type="checkbox" />
                    <span>Let the model update locations automatically (extra API call)</span></label>
                <label for="ffgc_trackevery">Update every N character messages</label>
                <input id="ffgc_trackevery" class="text_pole" type="number" min="1" max="20" step="1" />
                <label class="checkbox_label"><input id="ffgc_trackextra" type="checkbox" />
                    <span>Also update time and mood</span></label>
                <div class="menu_button" id="ffgc_trackbtn">Update scene now</div>
                <div id="ffgc_scene_box">
                    <label for="ffgc_location">Default location</label>
                    <input id="ffgc_location" class="text_pole" type="text" placeholder="e.g. The Rusty Anchor tavern" />
                    <label for="ffgc_places">Other places <small>(comma-separated; characters pick from these)</small></label>
                    <input id="ffgc_places" class="text_pole" type="text" placeholder="e.g. Market, Harbor, Castle" />
                    <label for="ffgc_time">Time</label>
                    <input id="ffgc_time" class="text_pole" type="text" placeholder="e.g. Late evening, raining" />
                    <label for="ffgc_atmosphere">Atmosphere / mood</label>
                    <input id="ffgc_atmosphere" class="text_pole" type="text" placeholder="e.g. Tense, quiet, smoky" />
                    <label for="ffgc_situation">Situation / scenario</label>
                    <textarea id="ffgc_situation" class="text_pole" rows="3"
                        placeholder="What is going on right now?"></textarea>
                    <label>Where each character is <small>(blank = default location)</small></label>
                    <div id="ffgc_members"></div>
                    <div class="menu_button" id="ffgc_refresh">Refresh from current chat</div>
                </div>

                <hr />
                <label for="ffgc_limit">Max characters per card</label>
                <input id="ffgc_limit" class="text_pole" type="number" min="100" max="10000" step="100" />
                <label for="ffgc_depth">Injection depth (0 = very end of the prompt)</label>
                <input id="ffgc_depth" class="text_pole" type="number" min="0" max="20" step="1" />
                <label for="ffgc_instruction">Extra instruction (optional)</label>
                <textarea id="ffgc_instruction" class="text_pole" rows="3"
                    placeholder="e.g. Keep other characters' contributions short."></textarea>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('#ffgc_enabled').prop('checked', settings.enabled).on('input', function () {
        settings.enabled = $(this).prop('checked'); saveSettings();
    });
    $('#ffgc_usescene').prop('checked', settings.useScene).on('input', function () {
        settings.useScene = $(this).prop('checked'); saveSettings();
    });
    $('#ffgc_inject').prop('checked', settings.injectCards).on('input', function () {
        settings.injectCards = $(this).prop('checked'); saveSettings();
    });
    $('#ffgc_split').prop('checked', settings.splitMessages).on('input', function () {
        settings.splitMessages = $(this).prop('checked'); saveSettings();
    });
    $('#ffgc_limit').val(settings.cardLimit).on('input', function () {
        settings.cardLimit = Math.max(100, Number($(this).val()) || defaultSettings.cardLimit); saveSettings();
    });
    $('#ffgc_depth').val(settings.depth).on('input', function () {
        settings.depth = Math.max(0, Number($(this).val()) || 0); saveSettings();
    });
    $('#ffgc_instruction').val(settings.instruction).on('input', function () {
        settings.instruction = String($(this).val()); saveSettings();
    });

    // Scene fields (per chat)
    const bindScene = (selector, key) => {
        $(selector).on('input', function () {
            getScene()[key] = String($(this).val());
            saveScene();
        });
    };
    bindScene('#ffgc_location', 'location');
    bindScene('#ffgc_places', 'places');
    bindScene('#ffgc_time', 'time');
    // Rebuild the dropdowns once the user finishes editing the place lists
    $('#ffgc_location, #ffgc_places').on('change', renderMembers);
    bindScene('#ffgc_atmosphere', 'atmosphere');
    bindScene('#ffgc_situation', 'situation');
    $('#ffgc_refresh').on('click', renderScene);

    $('#ffgc_autotrack').prop('checked', settings.autoTrack).on('input', function () {
        settings.autoTrack = $(this).prop('checked'); saveSettings();
    });
    $('#ffgc_trackevery').val(settings.trackEvery).on('input', function () {
        settings.trackEvery = Math.max(1, Number($(this).val()) || 1); saveSettings();
    });
    $('#ffgc_trackextra').prop('checked', settings.trackTimeMood).on('input', function () {
        settings.trackTimeMood = $(this).prop('checked'); saveSettings();
    });
    $('#ffgc_trackbtn').on('click', () => updateSceneFromChat(true));

    renderScene();
}

/** Fill the scene fields and the per-character location list from the current chat. */
function renderScene() {
    const ctx = SillyTavern.getContext();
    const box = $('#ffgc_scene_box');
    if (!box.length) return;

    if (!ctx.groupId) {
        box.css('opacity', 0.5);
        $('#ffgc_members').html('<small>Open a group chat to set the scene.</small>');
        return;
    }
    box.css('opacity', 1);

    const scene = getScene();
    $('#ffgc_location').val(scene.location);
    $('#ffgc_places').val(scene.places);
    $('#ffgc_time').val(scene.time);
    $('#ffgc_atmosphere').val(scene.atmosphere);
    $('#ffgc_situation').val(scene.situation);
    renderMembers();
}

/** One dropdown per character, filled from the default location + the places list. */
function renderMembers() {
    const scene = getScene();
    const places = [];
    const seen = new Set();
    const addPlace = p => {
        p = (p ?? '').trim();
        if (p && !seen.has(norm(p))) { seen.add(norm(p)); places.push(p); }
    };
    addPlace(scene.location);
    String(scene.places).split(',').forEach(addPlace);

    const list = $('#ffgc_members').empty();
    for (const member of getGroupMembers()) {
        const current = (scene.locations[member.avatar] ?? '').trim();
        const options = [...places];
        // keep a stale value selectable instead of silently dropping it
        if (current && !seen.has(norm(current))) options.push(current);

        const select = $('<select class="text_pole"></select>');
        select.append($('<option value=""></option>').text('Default location'));
        for (const p of options) {
            select.append($('<option></option>').attr('value', p).text(p));
        }
        select.val(current);
        select.on('change', function () {
            getScene().locations[member.avatar] = String($(this).val());
            saveScene();
        });

        const row = $('<div class="ffgc-member"></div>');
        row.append($('<small></small>').text(member.name));
        row.append(select);
        list.append(row);
    }
}

// ---------- init ----------

(function init() {
    const { eventSource, event_types } = SillyTavern.getContext();
    eventSource.on(event_types.APP_READY, addSettingsUi);
    eventSource.on(event_types.CHAT_CHANGED, renderScene);
    if (event_types.GROUP_UPDATED) eventSource.on(event_types.GROUP_UPDATED, renderScene);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    // registered after the splitter so any extra split messages already exist when tracking reads the chat
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, maybeTrack);
    console.log(TAG, 'loaded');
})();
