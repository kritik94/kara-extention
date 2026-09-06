import index from './index.html';
import QRCode from 'qrcode';
import { nanoid } from 'nanoid';
import { Database } from 'bun:sqlite'; // bundled with Bun, no extra dependency
import { networkInterfaces } from 'node:os';

/** key is the entry's own identity: the same song may sit in the queue twice. */
export type Found = { id: string; title: string };          // a search result
export type Song = Found & { key: string; uid: string; gen: number }; // an entry in the queue: who added it and into which generation
export type Status = 'queued' | 'playing' | 'played' | 'skipped' | 'removed';

/** The table is the queue: rows never leave it, they change status, so the evening stays readable afterwards
 *  and a song that has been sung still counts towards its owner's turn. Set once at startup, and by the tests. */
export let db: Database;
export const use = (d: Database) => (db = d);

/** Name and colour live with the user, not with the song: rename yourself and every song of yours follows.
 *  uid is whatever the guest's browser drew for itself — voluntary, unverified, and that is the whole point. */
export type User = { nick?: string; color?: string };
export const users = new Map<string, User>();

/** Guest input: the client's maxLength is only a hint, and the colour lands in a style attribute on the screen. */
export const setMe = (uid: string, nick?: string, color?: string) => {
  const me = {
    nick: nick?.trim().slice(0, 24) || undefined,
    color: /^#[0-9a-f]{6}$/i.test(color ?? '') ? color : undefined,
  };
  users.set(uid, me);
  return me;
};

export const withUsers = (songs: Song[]) => songs.map(s => ({ ...s, ...users.get(s.uid) }));

/** Five taps, nothing stored: an emoji is a moment on the screen, not state. */
export const EMOJI = ['🔥', '👏', '❤️', '😂', '🎉'];

export const ids = (text: string) =>
  [...text.matchAll(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/g)].map(m => m[1]);

/** The song on stage is over. The screen sends the id it just finished, the skip button sends nothing —
 *  which is also how the two statuses are told apart. The id guards a race: the screen finished A while the
 *  queue had already moved on, and closing nothing is better than closing someone else's song. */
export const skip = (id?: string) =>
  db.transaction(() => {
    const closed = db.run(
      "UPDATE songs SET status = ?, done = ? WHERE session = ? AND status = 'playing' AND (? IS NULL OR id = ?)",
      [id ? 'played' : 'skipped', Date.now(), session(), id ?? null, id ?? null],
    );
    if (closed.changes) promote();
  })();

/** By key, not by position: two guests may be deleting at the same time.
 *  A removed song stops counting towards its owner's generations — throw one out, add another, keep your place.
 *  Except the one on stage: taking it off is a skip, and a skip counts — otherwise "delete mine the moment
 *  it starts, add a new one" would keep you in generation zero all evening. */
export const remove = (key: string) =>
  db.transaction(() => {
    const gone = db.run(
      `UPDATE songs SET status = CASE status WHEN 'playing' THEN 'skipped' ELSE 'removed' END, done = ?
        WHERE session = ? AND key = ? AND status IN ('queued', 'playing')`,
      [Date.now(), session(), key],
    );
    if (gone.changes) promote(); // it may have been the song on stage
  })();

/** Nobody on stage: the first song waiting steps up. One statement, so two clients reporting the end
 *  at the same moment cannot promote two different songs. Also called at startup, so a restart in the
 *  middle of a song puts someone back on the microphone instead of leaving the queue stuck. */
export const promote = () =>
  db.run(
    `UPDATE songs SET status = 'playing'
      WHERE seq = (SELECT seq FROM songs WHERE session = ? AND status = 'queued' ORDER BY gen, seq LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM songs WHERE session = ? AND status = 'playing')`,
    [session(), session()],
  );

/** What everyone sees: the song on stage first, then whoever is waiting. */
export const list = () =>
  db.query(
    `SELECT key, id, title, uid, gen FROM songs WHERE session = ? AND status IN ('playing', 'queued')
      ORDER BY status = 'playing' DESC, gen, seq`,
  ).all(session()) as Song[];

/** The evening in the order songs were added: sung, skipped and thrown out alike.
 *  done is when a song left the stage (or the queue) — that is the order the evening actually went in. */
export const history = () =>
  db.query('SELECT key, id, title, uid, gen, status, done FROM songs WHERE session = ? ORDER BY seq')
    .all(session()) as (Song & { status: Status; done: number | null })[];

/** Generations. A guest's first GEN songs go into generation 0, the next GEN into generation 1, and so on;
 *  the queue is generations back to back, so a batch of twenty spreads out and a newcomer waits out
 *  one generation instead of the whole batch. The generation is stamped on the song when it is added
 *  and never recomputed: changing the setting cannot reshuffle what people already see in the queue.
 *  GEN = 0 switches the whole thing off — a plain queue, first come first served. */
export let GEN = Number(process.env.KARA_GEN ?? 3);

/** Comes in from the screen's panel: clamp instead of trusting it. NaN keeps the current value. */
export const setGen = (v: number) => (GEN = Number.isFinite(v) ? Math.min(10, Math.max(0, Math.round(v))) : GEN);

/** A query asked for one number: generations are counted with COUNT and MAX, nothing is kept in memory. */
const num = (sql: string, ...args: (string | number | null)[]) => Number(db.query(sql).values(...args)[0]?.[0] ?? 0);

/** Which generation a new song joins. Everything needed is in the table, and the songs already sung are
 *  still in it — that is what stops "wait for your song to end, then add one" from making you second
 *  every time. The stamp is written once and never recomputed, so turning the knob cannot reshuffle
 *  a queue people are already looking at. */
export function place(s: Song, per = GEN) {
  const sid = session();
  const kept = "session = ? AND status <> 'removed'"; // a song thrown out gives its slot back
  // the generation on stage: everything before it is over for everybody
  const head = num(
    `SELECT COALESCE((SELECT gen FROM songs WHERE session = ? AND status = 'playing'),
                     (SELECT MAX(gen) FROM songs WHERE session = ? AND status IN ('played', 'skipped')), 0)`,
    sid, sid,
  );
  let gen: number;
  if (!per) {
    // fairness off: behind everyone waiting, and seq settles the order inside the generation
    gen = num("SELECT COALESCE(MAX(gen), ?) FROM songs WHERE session = ? AND status IN ('queued', 'playing')", head, sid);
  } else {
    const mine = num(`SELECT COALESCE(MAX(gen), 0) FROM songs WHERE ${kept} AND uid = ?`, sid, s.uid);
    const n = num(`SELECT COUNT(*) FROM songs WHERE ${kept} AND uid = ? AND gen = ?`, sid, s.uid, mine);
    gen = Math.max(mine, head); // back after a break: into the current generation, never into the past
    if (gen === mine && n >= per) gen++; // filled that one, take the next; a catch-up starts its own count at zero
  }
  db.run('INSERT INTO songs (session, key, id, title, uid, gen, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [sid, s.key, s.id, s.title, s.uid, gen, 'queued', Date.now()]);
  promote(); // an empty stage: this one steps up right away
}

/** oembed: no API key and no quota, unlike the Data API */
async function titleOf(id: string) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://youtu.be/${id}&format=json`);
    if (!r.ok) throw new Error(`oembed ${r.status}`); // 401 for videos with embedding disabled, 429 when called too often
    return ((await r.json()) as { title: string }).title;
  } catch (e) {
    log(`название для ${id} не добылось (${e}), показываю id`);
    return id;
  }
}

/** title comes from whoever already knows it (search), which skips the extra oembed round trip. */
export const add = async (text: string, title: string | undefined, uid: string) => {
  const found = ids(text);
  const songs = await Promise.all(
    found.map(async id => ({
      key: nanoid(8),
      id,
      uid,
      gen: 0, // place() stamps the real one
      title: title && found.length === 1 ? title : await titleOf(id),
    })),
  );
  songs.forEach(s => place(s)); // one at a time: a paste of five links fills generations in order
  return list().length;
};

/** Walks the ytInitialData tree instead of matching markup: survives YouTube reshuffling its blocks. */
export function pickVideos(node: unknown, out: Found[] = []) {
  if (!node || typeof node !== 'object') return out;
  const v = (node as any).videoRenderer;
  if (v?.videoId && v.title?.runs?.[0]?.text) out.push({ id: v.videoId, title: v.title.runs[0].text });
  for (const child of Object.values(node)) pickVideos(child, out);
  return out;
}

export const searchURL = (q: string, karaoke: boolean) =>
  'https://www.youtube.com/results?search_query=' + encodeURIComponent(karaoke ? q + ' karaoke' : q);

export async function search(q: string, karaoke = true) {
  if (!q.trim()) return [];
  const html = await fetch(searchURL(q, karaoke), { headers: { 'Accept-Language': 'en-US' } }).then(r => r.text());
  const raw = html.match(/ytInitialData\s*=\s*(\{.+?\});<\/script>/s)?.[1];
  return raw ? pickVideos(JSON.parse(raw)).slice(0, 12) : [];
}

/** The address phones on the same network can open. 127.0.0.1 is useless to them. */
export function lanURL(port: number) {
  const ip = Object.values(networkInterfaces())
    .flat()
    .find(i => i?.family === 'IPv4' && !i.internal)?.address;
  return `http://${ip ?? '127.0.0.1'}:${port}`;
}

/** Sits next to the binary: run kara.exe in a folder and kara.db shows up there. */
export function openDB(path = process.env.KARA_DB ?? 'kara.db') {
  const d = new Database(path, { create: true });
  d.run(`CREATE TABLE IF NOT EXISTS songs (seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, key TEXT,
         id TEXT, title TEXT, uid TEXT, gen INTEGER, status TEXT, at INTEGER, done INTEGER)`);
  d.run('CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, nick TEXT, color TEXT)');
  d.run('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)');
  d.run("INSERT INTO settings (k, v) VALUES ('session', ?) ON CONFLICT(k) DO NOTHING", [nanoid(8)]);
  try { d.run('ALTER TABLE users ADD COLUMN color TEXT'); } catch {} // database written by a version without colours
  try { d.run('ALTER TABLE songs ADD COLUMN done INTEGER'); } catch {} // ...or by the first version of the history
  try { d.run('ALTER TABLE queue ADD COLUMN uid TEXT'); } catch {}    // ...an old queue written without users
  try { d.run('ALTER TABLE queue ADD COLUMN gen INTEGER'); } catch {} // ...or without generations
  // a queue from before the history: COALESCE covers the rows those ALTERs have just filled with NULL.
  // The old queue was ordered by pos, the new one is ordered by gen — with fairness off it used to append
  // songs stamped 0 behind higher generations, so the running maximum keeps the order people are looking at.
  try {
    d.transaction(() => {
      d.run(`INSERT INTO songs (session, key, id, title, uid, gen, status, at)
             SELECT (SELECT v FROM settings WHERE k = 'session'), key, id, title, COALESCE(uid, 'гость'),
                    MAX(COALESCE(gen, 0)) OVER (ORDER BY pos), 'queued', 0 FROM queue ORDER BY pos`);
      d.run('DROP TABLE queue');
    })();
  } catch {} // no such table: a fresh database, or one already carried over
  return d;
}

export const setting = (k: string) => (db.query('SELECT v FROM settings WHERE k = ?').get(k) as { v: string } | null)?.v;

export const setSetting = (k: string, v: string) =>
  db.run('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, v]);

/** One evening. Everything from earlier sessions is history: it stays in the table and weighs on nobody's turn. */
export const session = () => setting('session') ?? '1';
export const newSession = () =>
  db.transaction(() => {
    db.run("UPDATE songs SET status = 'skipped', done = ? WHERE session = ? AND status = 'playing'", [Date.now(), session()]); // the old evening ends tidy
    setSetting('session', nanoid(8)); // an id, not a timestamp: two evenings a millisecond apart are still two
  })();

export const loadUsers = () =>
  new Map(
    (db.query('SELECT uid, nick, color FROM users').all() as { uid: string; nick: string | null; color: string | null }[])
      .map(u => [u.uid, { nick: u.nick ?? undefined, color: u.color ?? undefined }] as const),
  );

export const saveUser = (uid: string, me: User) =>
  db.run(
    'INSERT INTO users (uid, nick, color) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET nick = excluded.nick, color = excluded.color',
    [uid, me.nick ?? null, me.color ?? null],
  );

type Handler = (req: Request, srv: Bun.Server) => Response | undefined | Promise<Response | undefined>;

/** Wraps every handler at once: add a route and its log line appears for free, nothing duplicated by hand. */
function logged<T extends Record<string, unknown>>(routes: T): T {
  const wrap = (path: string, fn: Handler): Handler => async (req, srv) => {
    const t = performance.now();
    const body = req.method === 'POST' ? await req.clone().text() : new URL(req.url).search.slice(1);
    try {
      const res = await fn(req, srv);
      log(`${req.method} ${path} ${body} → ${res?.status ?? '—'} ${Math.round(performance.now() - t)}ms, в очереди ${list().length}`);
      return res;
    } catch (e) {
      log(`${req.method} ${path} ${body} → упал: ${e}`); // log it, then rethrow — Bun turns it into a 500
      throw e;
    }
  };
  return Object.fromEntries(
    Object.entries(routes).map(([path, h]) => [
      path,
      typeof h === 'function' ? wrap(path, h as Handler)
      : isMethods(h) ? Object.fromEntries(Object.entries(h).map(([m, fn]) => [m, wrap(path, fn as Handler)]))
      : h, // index.html is an HTMLBundle, Bun serves it itself
    ]),
  ) as T;
}

/** Match on method names: an HTMLBundle has no own keys, so "every value is a function" is true for it. */
const isMethods = (h: unknown): h is Record<string, Handler> =>
  !!h && typeof h === 'object' && Object.keys(h).length > 0 &&
  Object.keys(h).every(k => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(k));

const log = (msg: string) => console.log(`${new Date().toLocaleTimeString('ru')}  ${msg}`);

const json = (data: unknown) =>
  Response.json(data, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });

if (import.meta.main) {
  use(openDB()); // the queue is in there: a restart picks the evening up where it stopped
  promote();     // ...and puts its head back on the microphone
  loadUsers().forEach((me, uid) => users.set(uid, me));
  setGen(Number(setting('gen'))); // NaN when the database has never seen the setting — the env default stands
  const port = Number(process.env.PORT ?? 8765);
  const url = lanURL(port);
  const qr = await QRCode.toString(url, { type: 'svg', margin: 2, color: { light: '#fff' } });

  const server = Bun.serve({
    port,
    hostname: '0.0.0.0', // otherwise phones on the same network cannot reach it
    routes: logged({
      '/': index,
      '/qr.svg': () => new Response(qr, { headers: { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' } }),
      '/queue': () => json(withUsers(list())),
      '/history': () => json(withUsers(history())), // the whole evening, statuses and all
      // A new evening: the queue starts empty and nobody carries a turn over from the last one
      '/session': { GET: () => json({ session: session() }), POST: () => (newSession(), push()) },
      '/gen': {
        GET: () => json({ gen: GEN }),
        // Nothing is pushed: songs already in the queue keep their generation, the new value meets the next one added
        POST: async req => (setSetting('gen', String(setGen(Number(await req.text())))), json({ gen: GEN })),
      },
      '/add': {
        POST: async req => {
          const p = new URL(req.url).searchParams;
          const uid = p.get('uid')?.slice(0, 64);
          if (!uid) return new Response('нужен uid', { status: 400 }); // without it there is nobody to count generations for
          await add(await req.text(), p.get('title') ?? undefined, uid);
          return push();
        },
      },
      '/me': {
        POST: async req => {
          const p = new URL(req.url).searchParams;
          const uid = p.get('uid')?.slice(0, 64);
          if (!uid) return new Response('нужен uid', { status: 400 });
          saveUser(uid, setMe(uid, p.get('nick') ?? undefined, p.get('color') ?? undefined));
          return push(); // everyone's copy of the queue shows the new name right away
        },
      },
      '/emoji': {
        POST: async req => {
          const e = await req.text();
          if (!EMOJI.includes(e)) return new Response('не та эмодзи', { status: 400 });
          const me = users.get(new URL(req.url).searchParams.get('uid') ?? '') ?? {}; // an unknown uid flies without a label
          server.publish('queue', JSON.stringify({ emoji: e, ...me })); // a message, not the queue: the clients tell them apart by shape
          return json({ ok: true });
        },
      },
      '/skip': { POST: async req => (skip((await req.text()) || undefined), push()) },
      '/remove': { POST: async req => (remove(await req.text()), push()) },
      '/search': async req => {
        const p = new URL(req.url).searchParams;
        return json(await search(p.get('q') ?? '', p.get('karaoke') !== '0'));
      },
    }),
    // State is pushed over the socket; actions stay plain RPC over POST
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('404', { status: 404 })),
    websocket: {
      open: ws => (ws.subscribe('queue'), ws.send(JSON.stringify(withUsers(list()))), log('ws + подключился')), // a new guest sees the queue right away
      close: () => log('ws − отключился'),
      message: () => {},
    },
  });

  /** Broadcast the queue to everyone and answer the caller with it. */
  const push = () => {
    const shown = withUsers(list()); // the table is the state, there is nothing to save first
    server.publish('queue', JSON.stringify(shown));
    return json(shown);
  };

  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  console.log(`экран: http://127.0.0.1:${port}   телефоны: ${url}`);
  console.log(`база: ${process.env.KARA_DB ?? 'kara.db'}, песен в очереди: ${list().length}`);
}
