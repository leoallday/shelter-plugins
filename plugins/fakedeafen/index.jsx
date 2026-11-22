import { getSocket, makeSocketWrap } from "../../common/socket-wrap.js";

const {
  flux: { storesFlat, awaitStore },
  plugin: { scoped, store },
  util: { getFiber },
  solid: { createSignal, createEffect, onCleanup },
  ui: { SwitchItem, Button, Divider },
} = shelter;

store.fakeDeafen ??= false;
store.keybind ??= "Ctrl+Shift+F";

function patchedSend(op, data, ...args) {
  if (op === 4 && store.fakeDeafen && data) {
    data.self_deaf = true;
    data.self_mute = true;
  }
  return patchedSend.__realSend.call(this, op, data, ...args);
}

const { ensureWrapped, restore } = makeSocketWrap(storesFlat, patchedSend);

function sendVoiceStateUpdate() {
  const socket = getSocket(storesFlat);
  const channelId = storesFlat["SelectedChannelStore"]?.getVoiceChannelId();
  if (!socket || !channelId) return;
  const channel = storesFlat["ChannelStore"]?.getChannel(channelId);
  const me = storesFlat["MediaEngineStore"];
  socket.send(4, {
    guild_id: channel?.guild_id ?? null,
    channel_id: channelId,
    self_mute: store.fakeDeafen || !!me?.isMute(),
    self_deaf: store.fakeDeafen || !!me?.isDeaf(),
    self_video: false,
    flags: 0,
  });
}

// Your own client draws your deafen state (voice channel row, account panel
// button, tray icon) from MediaEngineStore.isSelfDeaf(), i.e. local audio
// state, not from the voice state the server echoes back. Report the fake
// there too so you can see it, and re-render.
let mediaStore = null;
let realSelfDeaf = null;
let unloaded = false;

function isReallyDeaf() {
  try {
    return !!realSelfDeaf?.call(mediaStore);
  } catch {
    return false;
  }
}

function isReallyMuted() {
  try {
    return !!mediaStore?.getSettings?.().mute;
  } catch {
    return false;
  }
}

function refreshUi() {
  try {
    mediaStore?.emitChange();
  } catch {}
  updateBodyClasses();
}

// ---- green icons for the fake ----------------------------------------------
// Real deafen/mute stays red; the fake shows the same icons in green, on the
// account panel buttons and on your own row in the voice channel list.
// Elements are found through React fibers rather than hashed class names:
// panel buttons by their component props, row icons by their React key.

const GREEN = "var(--green-360, #23a55a)";
const greenA = (pct) => `color-mix(in srgb, ${GREEN} ${pct}%, transparent)`;
const CSS = `
body.fd-fake-deaf [data-fd-btn="deaf"],
body.fd-fake-mute [data-fd-btn="mute"] {
  --icon-voice-muted: ${GREEN};
  --icon-feedback-critical: ${GREEN};
  --opacity-red-12: ${greenA(12)};
  --opacity-red-24: ${greenA(24)};
  --opacity-red-52: ${greenA(52)};
}
body.fd-fake-deaf [data-fd-icon="deaf"],
body.fd-fake-mute [data-fd-icon="mute"] {
  color: ${GREEN} !important;
}
`;

function updateBodyClasses() {
  const fake = store.fakeDeafen && !unloaded;
  document.body.classList.toggle("fd-fake-deaf", fake && !isReallyDeaf());
  document.body.classList.toggle("fd-fake-mute", fake && !isReallyDeaf() && !isReallyMuted());
}

function findUp(fiber, pred, limit) {
  for (let f = fiber, i = 0; f && i < limit; f = f.return, i++) if (pred(f)) return f;
  return null;
}

const has = (o, k) => o != null && typeof o === "object" && k in o;

function setData(el, key, value) {
  if (el.dataset[key] !== value) el.dataset[key] = value;
}

// rT (deafen button) has selfDeaf/serverDeaf, rM (mic button) has selfMute/suppress.
function markPanelButton(el) {
  const f = findUp(
    getFiber(el),
    (f) => has(f.memoizedProps, "selfDeaf") || has(f.memoizedProps, "selfMute"),
    20,
  );
  const props = f?.memoizedProps;
  if (has(props, "selfDeaf") && !has(props, "selfMute")) setData(el, "fdBtn", "deaf");
  else if (has(props, "selfMute") && !has(props, "selfDeaf")) setData(el, "fdBtn", "mute");
}

// Voice row icons are wrapped in tooltips keyed "mute" / "deaf"; the icon list
// component above them gets the row's user.
function markRowIcon(el) {
  const keyed = findUp(getFiber(el), (f) => f.key === "deaf" || f.key === "mute", 8);
  if (!keyed) return;
  const row = findUp(keyed, (f) => has(f.memoizedProps, "serverDeaf") && has(f.memoizedProps, "user"), 12);
  const myId = storesFlat.UserStore?.getCurrentUser()?.id;
  if (row && myId && row.memoizedProps.user?.id === myId) setData(el, "fdIcon", keyed.key);
}

function safe(fn) {
  return (el) => {
    try {
      fn(el);
    } catch {}
  };
}

const PANEL_SEL = '[class*="audioButtonParent_"]';
const ROW_ICON_SEL = 'div[role="group"] svg';

function startIndicators() {
  scoped.ui.injectCss(CSS);
  scoped.observeDom(PANEL_SEL, safe(markPanelButton));
  scoped.observeDom(ROW_ICON_SEL, safe(markRowIcon));
  document.querySelectorAll(PANEL_SEL).forEach(safe(markPanelButton));
  document.querySelectorAll(ROW_ICON_SEL).forEach(safe(markRowIcon));
}

async function patchMediaEngine() {
  const me = storesFlat.MediaEngineStore ?? (await awaitStore("MediaEngineStore"));
  if (unloaded || !me) return;
  mediaStore = me;
  realSelfDeaf = me.isSelfDeaf;

  scoped.patcher.after("isSelfDeaf", me, (_, ret) => ret || store.fakeDeafen);

  // isDeaf() calls isSelfDeaf() and gates soundboard playback, so keep it on
  // the real state or you'd stop hearing soundboard sounds while faking.
  scoped.patcher.instead("isDeaf", me, function (args, orig) {
    if (!store.fakeDeafen || typeof this.isServerDeaf !== "function") return orig(...args);
    return !!realSelfDeaf.call(this) || !!this.isServerDeaf();
  });

  // real mute/deafen changes flip the icons between red and green
  me.addChangeListener(updateBodyClasses);
  scoped.onDispose(() => me.removeChangeListener(updateBodyClasses));

  refreshUi();
}

function setFake(on) {
  if (store.fakeDeafen === on) return;
  store.fakeDeafen = on;
  sendVoiceStateUpdate();
  refreshUi();
}

// While faking, the deafen and mic buttons (and Discord's own keybinds for
// them) show you as deafened/muted, so pressing one ends the fake instead of
// really deafening/muting you, like undeafening does in stock Discord.
function onToggleSelfDeaf(payload) {
  if (!store.fakeDeafen) return;
  if (payload.context != null && payload.context !== "default") return;
  if (payload.type === "AUDIO_TOGGLE_SELF_MUTE") {
    if (isReallyMuted() || isReallyDeaf()) return;
  } else if (payload.type !== "AUDIO_TOGGLE_SELF_DEAF") return;
  setTimeout(() => setFake(false));
  return false;
}

// Match on the physical key (e.code) so the bind works on any keyboard
// layout: on a Russian layout Ctrl+Shift+F gives e.key === "А".
function codeToKey(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

function parseKeybind(kb) {
  if (!kb) return null;
  const parts = kb.split("+").map((p) => p.trim());
  const key = parts.pop();
  if (!key) return null;
  return {
    key,
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}

function onKeyDown(e) {
  const kb = parseKeybind(store.keybind);
  if (!kb) return;
  if (
    codeToKey(e.code).toLowerCase() === kb.key.toLowerCase() &&
    e.ctrlKey === kb.ctrl &&
    e.shiftKey === kb.shift &&
    e.altKey === kb.alt
  ) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    setFake(!store.fakeDeafen);
  }
}

const RECONNECT_EVENTS = ["READY", "RESUMED", "CONNECTION_OPEN", "VOICE_STATE_UPDATES"];

export function onLoad() {
  unloaded = false;
  ensureWrapped();
  scoped.flux.intercept(onToggleSelfDeaf);
  patchMediaEngine().catch((e) => console.error("[FakeDeafen] MediaEngineStore patch failed", e));
  startIndicators();
  for (const t of RECONNECT_EVENTS) scoped.flux.subscribe(t, ensureWrapped);
  const poll = setInterval(ensureWrapped, 200);
  setTimeout(() => clearInterval(poll), 10000);
  document.addEventListener("keydown", onKeyDown, true);
}

export function onUnload() {
  unloaded = true;
  document.removeEventListener("keydown", onKeyDown, true);
  restore();
  if (store.fakeDeafen) {
    store.fakeDeafen = false;
    sendVoiceStateUpdate();
  }
  refreshUi();
  document.body.classList.remove("fd-fake-deaf", "fd-fake-mute");
  mediaStore = null;
  realSelfDeaf = null;
}

export function settings() {
  const [recording, setRecording] = createSignal(false);
  const [kb, setKb] = createSignal(store.keybind);

  createEffect(() => {
    if (!recording()) return;
    const onRecord = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(false);
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const parts = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      parts.push(codeToKey(e.code));
      const combo = parts.join("+");
      store.keybind = combo;
      setKb(combo);
      setRecording(false);
    };
    document.addEventListener("keydown", onRecord, true);
    onCleanup(() => document.removeEventListener("keydown", onRecord, true));
  });

  return (
    <div style="display:flex;flex-direction:column;gap:12px;">
      <SwitchItem value={store.fakeDeafen} onChange={setFake}>
        Fake Deafen
      </SwitchItem>
      <Divider />
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <span>Keybind</span>
        <div style="display:flex;gap:8px;">
          <Button onClick={() => setRecording(!recording())}>
            {recording() ? "Press a key combination..." : kb() || "Click to set"}
          </Button>
          {!recording() && kb() && (
            <Button
              onClick={() => {
                store.keybind = "";
                setKb("");
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
