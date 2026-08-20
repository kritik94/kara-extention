import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Found = { id: string; title: string };
type Song = Found & { key: string };
const thumb = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const post = (path: string, body?: string) => fetch(path, { method: 'POST', body }).then(r => r.json());

function App() {
  const [queue, setQueue] = useState<Song[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [karaoke, setKaraoke] = useState(true);
  const [qr, setQr] = useState(false);
  const [copied, setCopied] = useState(false);

  // The queue belongs to the server: the socket pushes state, we render whatever arrived
  useEffect(() => {
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onmessage = e => setQueue(JSON.parse(e.data));
      ws.onclose = () => (retry = setTimeout(connect, 2000)); // the phone went to sleep or the server blinked
    };
    connect();
    return () => (clearTimeout(retry), (ws.onclose = null), ws.close());
  }, []);

  useEffect(() => {
    if (!q.trim()) return setFound([]);
    const t = setTimeout(
      () => fetch(`/search?q=${encodeURIComponent(q)}&karaoke=${karaoke ? 1 : 0}`).then(r => r.json()).then(setFound),
      300,
    );
    return () => clearTimeout(t); // drop the pending request on every keystroke and on toggling the checkbox
  }, [q, karaoke]);

  /** The clipboard API needs a secure context, but guests arrive over http — hence the fallback. */
  const copyLink = async () => {
    try {
      if (!navigator.clipboard) throw new Error('нет clipboard на http');
      await navigator.clipboard.writeText(location.origin);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = location.origin;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const addSong = (s: Found) => {
    setQ('');
    post(`/add?title=${encodeURIComponent(s.title)}`, `https://youtu.be/${s.id}`).then(setQueue);
  };

  return (
    <>
      <div className="search">
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Название песни или ссылка" />
        {q && <button className="clear" onClick={() => setQ('')} aria-label="Очистить поиск">✕</button>}
      </div>
      <div className="bar">
        <label className="only">
          <input type="checkbox" checked={karaoke} onChange={e => setKaraoke(e.target.checked)} />
          только караоке
        </label>
        <button onClick={() => setQr(!qr)}>{qr ? 'Скрыть QR' : 'Поделиться'}</button>
      </div>
      {qr && (
        <div className="qr">
          <img src="/qr.svg" alt="QR со ссылкой на эту страницу" />
          <div className="link">
            <span>{location.origin}</span>
            <button onClick={copyLink} aria-label={copied ? 'Скопировано' : 'Скопировать ссылку'}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {copied ? (
                  <path d="M20 6 9 17l-5-5" />
                ) : (
                  <>
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </>
                )}
              </svg>
            </button>
          </div>
        </div>
      )}
      {q.trim() && (
        <>
          <h2>Найдено</h2>
          {found.map(s => (
            <div className="row" key={s.id}>
              <img src={thumb(s.id)} />
              <div className="t">{s.title}</div>
              <button onClick={() => addSong(s)}>+</button>
            </div>
          ))}
        </>
      )}
      <h2>Очередь</h2>
      {queue.length === 0 && <div className="t">Пусто — добавь песню</div>}
      {queue.map((s, i) => (
        <div className="row" key={s.key}>
          <img src={thumb(s.id)} />
          <div className="t">
            {i === 0 && <div className="now">Сейчас играет</div>}
            {s.title}
          </div>
          <button onClick={() => post('/remove', s.key).then(setQueue)}>
            {i === 0 ? '⏭' : '✕'}
          </button>
        </div>
      ))}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
