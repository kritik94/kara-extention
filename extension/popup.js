const API = 'http://127.0.0.1:8765'; // the same address the content script talks to
const btn = document.getElementById('toggle');
const fresh = document.getElementById('new');
const enabled = async () => (await chrome.storage.local.get('enabled')).enabled ?? true; // on by default

function paint(on) {
  btn.textContent = on ? '● Работает' : '○ Выключено';
  btn.classList.toggle('on', on);
}

btn.onclick = async () => {
  const on = !(await enabled());
  await chrome.storage.local.set({ enabled: on }); // content.js listens to storage — applies at once in every tab
  paint(on);
};

// Two taps instead of a confirm(): a dialog can close the popup out from under itself, and this
// wipes the queue for everybody. The question forgets itself if the second tap does not come.
let asked = 0, timer;
const reset = () => (fresh.textContent = 'Новый вечер', fresh.classList.remove('ask'));
fresh.onclick = async () => {
  if (Date.now() - asked > 3000) {
    asked = Date.now();
    fresh.textContent = 'Точно? Нажми ещё раз';
    fresh.classList.add('ask');
    return (timer = setTimeout(reset, 3000));
  }
  clearTimeout(timer); // the question is answered: it must not wipe the outcome below
  asked = 0;
  fresh.classList.remove('ask');
  const ok = await fetch(API + '/session', { method: 'POST' }).then(r => r.ok, () => false);
  fresh.textContent = ok ? 'Готово' : 'Сервер не отвечает';
  setTimeout(reset, 1500);
};

enabled().then(paint);
