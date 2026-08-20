// Инвариант: queue[0] — то, что должно играть сейчас. Источник правды — сервер.
const API = 'http://127.0.0.1:8765'; // не localhost: на macOS он резолвится в ::1, где сервер не слушает
const current = () => new URLSearchParams(location.search).get('v');
const api = (path, body) =>
  fetch(API + path, body === undefined ? undefined : { method: 'POST', body }) // строка в body = text/plain, без preflight
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
// Названия приходят от YouTube и от гостей — в innerHTML их нельзя пускать сырыми
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Перетаскивание кнопки: pointer-события покрывают и мышь, и палец
const toggle = $('toggle');
let drag = null;
let dragged = false;

const place = (x, y) => {
  panel.style.left = Math.max(0, Math.min(x, innerWidth - panel.offsetWidth)) + 'px';
  panel.style.top = Math.max(0, Math.min(y, innerHeight - panel.offsetHeight)) + 'px';
  panel.style.right = 'auto'; // в CSS панель прижата вправо, при перетаскивании ведём по left
};

toggle.onpointerdown = e => {
  const r = panel.getBoundingClientRect();
  drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY };
  dragged = false;
  toggle.setPointerCapture(e.pointerId); // не теряем кнопку, если курсор ушёл за её край
};

toggle.onpointermove = e => {
  if (!drag) return;
  dragged ||= Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4; // порог, иначе дрожь руки съест клик
  if (dragged) place(e.clientX - drag.dx, e.clientY - drag.dy), placeBody(); // меню едет за кнопкой
};

toggle.onpointerup = () => {
  if (dragged) chrome.storage.local.set({ pos: { x: parseFloat(panel.style.left), y: parseFloat(panel.style.top) } });
  drag = null;
};

const GAP = 8;

/** Держим меню в окне: прижимаем к правому краю кнопки, при нехватке места снизу — раскрываем вверх. */
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
  placeBody(); // считаем после показа: у скрытого элемента нет размеров
};

addEventListener('resize', placeBody);
$('skip').onclick = async () => render(await api('/skip'));
$('big').onclick = async () => chrome.storage.local.set({ big: !(await chrome.storage.local.get('big')).big });
$('list').onclick = async e => { if (e.target.dataset.key) render(await api('/remove', e.target.dataset.key)); };

function render(queue) {
  if (!queue) return ($('list').innerHTML = '<li>сервер недоступен</li>'); // молчим и играем дальше
  $('list').innerHTML = queue
    .map((s, i) => `<li>${i ? '' : '▶ '}${esc(s.title)} <button data-key="${esc(s.key)}">✕</button></li>`)
    .join('');
  if (queue[0] && queue[0].id !== current()) location.href = `https://www.youtube.com/watch?v=${queue[0].id}`;
}

// Кольцо вокруг кнопки = сколько песни отыграно
document.addEventListener('timeupdate', e => {
  const v = e.target;
  if (v.tagName !== 'VIDEO' || !v.duration) return; // у рекламы и до загрузки метаданных duration = NaN
  panel.style.setProperty('--p', v.currentTime / v.duration);
}, true);

// ended не всплывает, но ловится на capture-фазе — не надо ждать появления <video>
document.addEventListener('ended', async e => {
  if (e.target.tagName !== 'VIDEO') return;
  if (document.querySelector('.ad-showing')) return; // реклама играет в том же <video>
  render(await api('/skip', current())); // id — чтобы не снять чужую голову очереди
}, true);

const syncBig = async () => {
  const { big, pos } = await chrome.storage.local.get(['big', 'pos']);
  document.documentElement.classList.toggle('kara-big', !!big);
  if (pos && panel.isConnected) place(pos.x, pos.y); // позиция переживает переход к следующей песне
};
chrome.storage.onChanged.addListener(syncBig);
syncBig();

document.addEventListener('DOMContentLoaded', () => (document.body.append(panel), syncBig()), { once: true });
// <img src="http://..."> со страницы HTTPS Chrome блокирует как mixed content, а fetch — нет
fetch(API + '/qr.svg')
  .then(r => r.text())
  .then(svg => ($('qr').innerHTML = svg))
  .catch(() => {});

// Состояние приходит по сокету; действия — обычные POST выше
(function connect() {
  const ws = new WebSocket(API.replace('http', 'ws') + '/ws');
  ws.onmessage = e => render(JSON.parse(e.data));
  ws.onclose = () => (render(null), setTimeout(connect, 2000));
})();
