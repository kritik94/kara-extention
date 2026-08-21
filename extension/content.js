// Invariant: queue[0] is what should be playing now. The server owns the truth.
const API = 'http://127.0.0.1:8765'; // not localhost: on macOS it resolves to ::1, where the server does not listen
const current = () => new URLSearchParams(location.search).get('v');
// Every route here is an action, and every action is a POST — /skip with no id means "skip whatever is playing"
const api = (path, body = '') =>
  fetch(API + path, { method: 'POST', body }) // a string body means text/plain, so no preflight
    .then(r => r.json())
    .catch(() => null);

const panel = document.createElement('div');
panel.id = 'kara';
panel.innerHTML = `
  <button id="kara-toggle">🎤</button>
  <div id="kara-body" hidden>
    <p><button id="kara-skip">Пропустить</button><button id="kara-big">Во весь экран</button></p>
    <p><button id="kara-notify" title="Кто поёт и кто следующий: 10 секунд до конца песни и 10 после начала новой">Объявлять песни</button></p>
    <ol id="kara-list"></ol>
    <div id="kara-qr" title="QR на страницу очереди"></div>
  </div>
  <div id="kara-next" hidden></div>
  <div id="kara-emojis"></div>`;

const $ = id => panel.querySelector('#kara-' + id);
let enabled = true; // switched off in the popup — the extension leaves the page alone entirely
let notify = true; // the on-screen card around the song change
const CARD = 10; // seconds of card on each side of the change — before the end and after the next one starts
let cardNow = '', cardNext = ''; // rebuilt by render(), shown by timeupdate
// Titles come from YouTube and from guests — never feed them raw to innerHTML
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const who = s => (s.nick ? ` <i${s.color ? ` style="color:${esc(s.color)}"` : ''}>${esc(s.nick)}</i>` : '');

// Dragging the button: pointer events cover both mouse and finger
const toggle = $('toggle');
let drag = null;
let dragged = false;

const place = (x, y) => {
  panel.style.left = Math.max(0, Math.min(x, innerWidth - panel.offsetWidth)) + 'px';
  panel.style.top = Math.max(0, Math.min(y, innerHeight - panel.offsetHeight)) + 'px';
  panel.style.right = 'auto'; // CSS pins the panel to the right; while dragging we drive it by left
};

toggle.onpointerdown = e => {
  const r = panel.getBoundingClientRect();
  drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
  dragged = false;
  toggle.setPointerCapture(e.pointerId); // keeps the button even if the cursor leaves its edge
};

toggle.onpointermove = e => {
  if (!drag) return;
  dragged ||= Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4; // threshold, otherwise a shaky hand eats the click
  if (dragged) place(e.clientX - drag.dx, e.clientY - drag.dy), placeBody(); // the menu follows the button
};

toggle.onpointerup = () => {
  if (dragged) chrome.storage.local.set({ pos: { x: parseFloat(panel.style.left), y: parseFloat(panel.style.top) } });
  drag = null;
};

const GAP = 8;

/** Keeps the menu on screen: aligned to the button's right edge, flipped upwards when there is no room below. */
function placeBody() {
  const body = $('body');
  if (body.hidden) return;
  const r = toggle.getBoundingClientRect();
  const fitsBelow = r.bottom + GAP + body.offsetHeight <= innerHeight - GAP;
  const left = Math.min(r.right - body.offsetWidth, innerWidth - body.offsetWidth - GAP);
  const top = fitsBelow ? r.bottom + GAP : r.top - GAP - body.offsetHeight;
  body.style.left = Math.max(GAP, left) + 'px';
  body.style.top = Math.max(GAP, top) + 'px';
}

toggle.onclick = () => {
  if (dragged) return;
  $('body').hidden = !$('body').hidden;
  placeBody(); // measure after unhiding: a hidden element has no size
};

addEventListener('resize', placeBody);
$('skip').onclick = async () => render(await api('/skip'));
$('big').onclick = async () => chrome.storage.local.set({ big: !(await chrome.storage.local.get('big')).big });
$('notify').onclick = () => chrome.storage.local.set({ notify: !notify }); // syncBig() repaints through storage.onChanged
$('list').onclick = async e => { if (e.target.dataset.key) render(await api('/remove', e.target.dataset.key)); };

/** One tap on a phone, one emoji floating up the left edge signed by its sender — a message, not just a decoration.
 *  Nothing to clean up: it removes itself when the animation ends. */
function fly(m) {
  const el = document.createElement('span');
  el.innerHTML = esc(m.emoji) + who(m); // who() escapes the nick and paints it in the guest's colour
  el.style.left = 24 + Math.random() * 40 + 'px'; // jitter, so two taps at once do not land on top of each other
  el.style.setProperty('--x', (Math.random() * 2 - 1).toFixed(2)); // slight sideways drift
  el.onanimationend = () => el.remove();
  $('emojis').append(el);
}

function render(queue) {
  if (!queue) return ($('list').innerHTML = '<li>сервер недоступен</li>'); // stay quiet and keep playing
  const card = (s, label) => (s ? `${label}: ${esc(s.title)}${who(s)}` : '');
  cardNow = card(queue[0], 'Сейчас');
  cardNext = card(queue[1], 'Далее');
  $('list').innerHTML = queue
    .map((s, i) => `<li>${i ? '' : '▶ '}${esc(s.title)}${who(s)} <button data-key="${esc(s.key)}">✕</button></li>`)
    .join('');
  if (enabled && queue[0] && queue[0].id !== current()) location.href = `https://www.youtube.com/watch?v=${queue[0].id}`;
}

// The ring around the button shows how much of the song has played
document.addEventListener('timeupdate', e => {
  const v = e.target;
  if (v.tagName !== 'VIDEO' || !v.duration) return; // duration is NaN during ads and before metadata loads
  panel.style.setProperty('--p', v.currentTime / v.duration);
  // A song change reloads the page, so the "now" half also covers a skip: the next video simply starts at zero.
  // Recomputed on every tick — rewinding hides the card again, no flag to reset.
  const text = document.querySelector('.ad-showing') ? '' // ads run in the same <video>: their edges are not ours
    : v.currentTime <= CARD ? cardNow
    : v.duration - v.currentTime <= CARD ? cardNext
    : '';
  const el = $('next');
  if (el.innerHTML !== text) el.innerHTML = text;
  el.hidden = !(enabled && notify && text);
}, true);

// ended does not bubble but is caught in the capture phase — no need to wait for <video> to appear
document.addEventListener('ended', async e => {
  if (!enabled || e.target.tagName !== 'VIDEO') return;
  if (document.querySelector('.ad-showing')) return; // ads play in the very same <video>
  render(await api('/skip', current())); // send the id so we never drop someone else's head of the queue
}, true);

const syncBig = async () => {
  const { big, pos, enabled: saved, notify: savedNotify } = await chrome.storage.local.get(['big', 'pos', 'enabled', 'notify']);
  enabled = saved ?? true; // the popup switch controls both the logic and the on-screen button
  notify = savedNotify ?? true;
  $('notify').classList.toggle('on', notify);
  panel.hidden = !enabled;
  document.documentElement.classList.toggle('kara-big', !!big);
  if (pos && panel.isConnected) place(pos.x, pos.y); // the position survives the jump to the next song
};
chrome.storage.onChanged.addListener(syncBig);
syncBig();

document.addEventListener('DOMContentLoaded', () => (document.body.append(panel), syncBig()), { once: true });
// Chrome blocks <img src="http://..."> from an HTTPS page as mixed content, but not fetch
fetch(API + '/qr.svg')
  .then(r => r.text())
  .then(svg => ($('qr').innerHTML = svg))
  .catch(() => {});

// State arrives over the socket; actions are the plain POSTs above
(function connect() {
  const ws = new WebSocket(API.replace('http', 'ws') + '/ws');
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    Array.isArray(m) ? render(m) : fly(m); // the queue is an array, an emoji is an object
  };
  ws.onclose = () => (render(null), setTimeout(connect, 2000));
})();
