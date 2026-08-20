const btn = document.getElementById('toggle');
const enabled = async () => (await chrome.storage.local.get('enabled')).enabled ?? true; // по умолчанию работает

function paint(on) {
  btn.textContent = on ? '● Работает' : '○ Выключено';
  btn.classList.toggle('on', on);
}

btn.onclick = async () => {
  const on = !(await enabled());
  await chrome.storage.local.set({ enabled: on }); // content.js слушает storage — применяется сразу во всех вкладках
  paint(on);
};

enabled().then(paint);
