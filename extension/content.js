// Invariant: queue[0] is what should be playing now. The server owns the truth.
const API = 'http://127.0.0.1:8765'; // not localhost: on macOS it resolves to ::1, where the server does not listen
const current = () => new URLSearchParams(location.search).get('v');
const api = (path, body) =>
  fetch(API + path, body === undefined ? undefined : { method: 'POST', body }) // a string body means text/plain, so no preflight
    .then(r => r.json())
    .catch(() => null);

const panel = document.createElement('div');
panel.id = 'kara';
panel.innerHTML = `
  <button id="kara-toggle">🎤</button>
  <div id="kara-body" hidden>
    <p><button id="kara-skip">Пропустить</button><button id="kara-big">Во весь экран</button></p>
    <ol id="kara-list"></ol>
    <div id="kara-qr" title="QR на страницу очереди"></div>
  </div>`;

const $ = id => panel.querySelector('#kara-' + id);
let enabled = true; // switched off in the popup — the extension leaves the page alone entirely
// Titles come from YouTube and from guests — never feed them raw to innerHTML
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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
$('list').onclick = async e => { if (e.target.dataset.key) render(await api('/remove', e.target.dataset.key)); };

function render(queue) {
  if (!queue) return ($('list').innerHTML = '<li>сервер недоступен</li>'); // stay quiet and keep playing
  $('list').innerHTML = queue
    .map((s, i) => `<li>${i ? '' : '▶ '}${esc(s.title)}${s.nick ? ` <i${s.color ? ` style="color:${esc(s.color)}"` : ''}>${esc(s.nick)}</i>` : ''} <button data-key="${esc(s.key)}">✕</button></li>`)
    .join('');
  if (enabled && queue[0] && queue[0].id !== current()) location.href = `https://www.youtube.com/watch?v=${queue[0].id}`;
}

// The ring around the button shows how much of the song has played
document.addEventListener('timeupdate', e => {
  const v = e.target;
  if (v.tagName !== 'VIDEO' || !v.duration) return; // duration is NaN during ads and before metadata loads
  panel.style.setProperty('--p', v.currentTime / v.duration);
}, true);

// ended does not bubble but is caught in the capture phase — no need to wait for <video> to appear
document.addEventListener('ended', async e => {
  if (!enabled || e.target.tagName !== 'VIDEO') return;
  if (document.querySelector('.ad-showing')) return; // ads play in the very same <video>
  render(await api('/skip', current())); // send the id so we never drop someone else's head of the queue
}, true);

const syncBig = async () => {
  const { big, pos, enabled: saved } = await chrome.storage.local.get(['big', 'pos', 'enabled']);
  enabled = saved ?? true; // the popup switch controls both the logic and the on-screen button
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
  ws.onmessage = e => render(JSON.parse(e.data));
  ws.onclose = () => (render(null), setTimeout(connect, 2000));
})();
