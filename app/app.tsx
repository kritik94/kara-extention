import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Found = { id: string; title: string };
type Song = Found & { key: string; uid: string; nick?: string; color?: string };
const thumb = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const post = (path: string, body?: string) => fetch(path, { method: 'POST', body }).then(r => r.json());

/** Who this browser is. randomUUID needs a secure context and guests arrive over plain http — getRandomValues does not. */
const uid = (localStorage.uid ??= crypto.getRandomValues(new Uint32Array(4)).join('-'));

/** Same five as the server's whitelist — anything else comes back 400. */
const EMOJI = ['🔥', '👏', '❤️', '😂', '🎉'];

/** Tailwind's 400 shades: all sixteen stay readable on the dark background. */
const PALETTE = ['#f87171', '#fb923c', '#fbbf24', '#facc15', '#a3e635', '#4ade80', '#34d399', '#2dd4bf',
                 '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#e879f9', '#f472b6', '#fb7185'];

function App() {
  const [queue, setQueue] = useState<Song[]>([]);
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Found[]>([]);
  const [karaoke, setKaraoke] = useState(localStorage.karaoke !== '0'); // a setting now, so it outlives the reload
  const [copied, setCopied] = useState(false);
  // The server owns name and colour; the copies here just fill the menu after a reload
  const [nick, setNick] = useState(localStorage.nick ?? '');
  const [color, setColor] = useState(localStorage.color ?? '');
  const [edit, setEdit] = useState(false);
  const [palette, setPalette] = useState(false);
  const [tab, setTab] = useState<'queue' | 'find' | 'me'>('queue');
  /** Last few queries that actually led to a song — kept per browser, the server has no business knowing them. */
  /** A guard against fat fingers, not a permission: /remove still takes anyone's word for it. */
  const [others, setOthers] = useState(localStorage.others === '1');
  const [history, setHistory] = useState<string[]>(() => { try { return JSON.parse(localStorage.history ?? '[]'); } catch { return []; } });

  const saveMe = (n: string, c: string) => {
    localStorage.nick = n;
    localStorage.color = c;
    post(`/me?uid=${uid}&nick=${encodeURIComponent(n)}&color=${encodeURIComponent(c)}`).then(setQueue);
  };

  // The queue belongs to the server: the socket pushes state, we render whatever arrived
  useEffect(() => {
    let ws: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onmessage = e => {
        const m = JSON.parse(e.data);
        if (Array.isArray(m)) setQueue(m); // anything else is an emoji, and those fly on the screen, not here
      };
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
    const h = [q.trim(), ...history.filter(x => x !== q.trim())].slice(0, 8);
    localStorage.history = JSON.stringify(h);
    setHistory(h);
    post(`/add?title=${encodeURIComponent(s.title)}&uid=${uid}`, `https://youtu.be/${s.id}`).then(setQueue);
  };

  return (
    <>
      {/* The only thing that scrolls: the bar below stays put no matter how long the queue is.
          Search reads like a chat — the field at the bottom under the thumb, the best match right above it. */}
      {/* key={tab}: a fresh element per tab, so a scrolled queue doesn't leave the next tab scrolled out of view */}
      <div key={tab} className={tab === 'find' ? 'page rev' : 'page'}>
        {tab === 'me' && (
          <div className="field">
            <span>Имя</span>
            <div className="line">
              {edit ? (
                <>
                  <input
                    autoFocus
                    aria-label="Имя"
                    value={nick}
                    maxLength={24}
                    placeholder="Будет видно у твоих песен"
                    onChange={e => setNick(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (saveMe(nick, color), setEdit(false))}
                  />
                  <button className="icon" aria-label="Применить" onClick={() => (saveMe(nick, color), setEdit(false))}>✓</button>
                </>
              ) : (
                <>
                  <span className="me" style={{ color: color || undefined }}>{nick || 'без имени'}</span>
                  <button className="icon" aria-label="Изменить имя" onClick={() => setEdit(true)}>✎</button>
                </>
              )}
              <button
                className="swatch"
                aria-label="Цвет"
                aria-expanded={palette}
                style={{ background: color || '#888' }}
                onClick={() => setPalette(!palette)}
              />
            </div>
            {palette && (
              <div className="grid">
                {PALETTE.map(c => (
                  <button
                    key={c}
                    aria-label={c}
                    aria-pressed={c === color}
                    style={{ background: c }}
                    onClick={() => (setColor(c), saveMe(nick, c), setPalette(false))}
                  />
                ))}
              </div>
            )}
            <label className="only">
              <input
                type="checkbox"
                checked={karaoke}
                onChange={e => (setKaraoke(e.target.checked), (localStorage.karaoke = e.target.checked ? '' : '0'))}
              />
              искать только караоке
            </label>
            <label className="only">
              <input
                type="checkbox"
                checked={others}
                onChange={e => (setOthers(e.target.checked), (localStorage.others = e.target.checked ? '1' : ''))}
              />
              управлять чужими песнями
            </label>
          </div>
        )}

        {tab === 'find' && (
          <>
            <div className="search">
              {/* type="search": a song title is not a word the phone knows, and Chrome leaves search fields
                  out of autofill — which is what takes its key/card/address strip off the keyboard */}
              <input
                type="search"
                enterKeyHint="search"
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Название песни или ссылка"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              {q && <button className="clear" onClick={() => setQ('')} aria-label="Очистить поиск">✕</button>}
            </div>
            {!q.trim() && history.length > 0 && (
              <>
                <h2>Недавний поиск</h2>
                {history.map(h => (
                  <button className="row hist" key={h} onClick={() => setQ(h)}>{h}</button>
                ))}
              </>
            )}
            {q.trim() && (
              <>
                <h2>Найдено</h2>
                {found.map(s => {
                  // the queue that comes back from /add is the whole state — its index is the position, no extra flag
                  const pos = queue.findIndex(x => x.id === s.id);
                  return (
                    <div className="row" key={s.id}>
                      <img src={thumb(s.id)} />
                      <div className="t">{s.title}</div>
                      {pos >= 0 && <span className="pos">{pos === 0 ? 'сейчас' : `#${pos + 1}`}</span>}
                      <button onClick={() => addSong(s)} disabled={pos >= 0}>{pos >= 0 ? '✓' : '+'}</button>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}

        {tab === 'queue' && (
          <>
            <h2>Очередь</h2>
            {queue.length === 0 && <div className="t">Пусто — добавь песню</div>}
            {queue.map((s, i) => (
              <div className="row" key={s.key}>
                <img src={thumb(s.id)} />
                <div className="t">
                  {i === 0 && <div className="now">Сейчас играет</div>}
                  {s.title}
                  {s.nick && <div className="nick" style={{ color: s.color }}>{s.nick}</div>}
                </div>
                {(others || s.uid === uid) && (
                  <button onClick={() => post('/remove', s.key).then(setQueue)}>
                    {i === 0 ? '⏭' : '✕'}
                  </button>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      {/* The thumb lives at the bottom of a phone: tabs and emoji sit under the content, not above it */}
      <div className="bar">
        {tab === 'queue' && (
          <div className="emoji">
            {EMOJI.map(e => (
              <button key={e} onClick={() => post(`/emoji?uid=${uid}`, e)} aria-label={`Отправить ${e}`}>{e}</button>
            ))}
          </div>
        )}
        <div className="tabs">
          <button className={tab === 'queue' ? 'tab on' : 'tab'} onClick={() => setTab('queue')}>Очередь</button>
          <button className={tab === 'find' ? 'tab on' : 'tab'} onClick={() => setTab('find')}>Поиск</button>
          <button className={tab === 'me' ? 'tab on' : 'tab'} onClick={() => setTab('me')}>Профиль</button>
          {/* <details> holds the open/closed state — no useState, and Esc/outside taps stay the browser's job */}
          <details className="drop">
            <summary aria-label="Поделиться">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3" />
                <circle cx="6" cy="12" r="3" />
                <circle cx="18" cy="19" r="3" />
                <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
              </svg>
            </summary>
            <div className="sheet qr">
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
          </details>
        </div>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
