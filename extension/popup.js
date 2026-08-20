const btn = document.getElementById('toggle');
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

enabled().then(paint);
