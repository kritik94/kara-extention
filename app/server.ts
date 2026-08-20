import index from './index.html';
import QRCode from 'qrcode';
import { nanoid } from 'nanoid';
import { Database } from 'bun:sqlite'; // bundled with Bun, no extra dependency
import { networkInterfaces } from 'node:os';

/** key is the entry's own identity: the same song may sit in the queue twice. */
export type Found = { id: string; title: string };          // a search result
export type Song = Found & { key: string; uid?: string };    // an entry in the queue, uid is whoever added it
export const queue: Song[] = [];

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

export const withUsers = (songs: Song[]) => songs.map(s => ({ ...s, ...users.get(s.uid ?? '') }));

export const ids = (text: string) =>
  [...text.matchAll(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/g)].map(m => m[1]);

export function skip(id?: string) {
  // id guards a race: the screen finished A while the queue moved on — never swallow someone else's song
  if (queue.length && (!id || queue[0].id === id)) queue.shift();
}

export function remove(key: string) {
  const i = queue.findIndex(s => s.key === key);
  if (i >= 0) queue.splice(i, 1); // by key, not by index: two guests may be deleting at the same time
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
export const add = async (text: string, title?: string, uid?: string) => {
  const found = ids(text);
  return queue.push(
    ...(await Promise.all(
      found.map(async id => ({
        key: nanoid(8),
        id,
        uid,
        title: title && found.length === 1 ? title : await titleOf(id),
      })),
    )),
  );
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
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE IF NOT EXISTS queue (pos INTEGER PRIMARY KEY, key TEXT, id TEXT, title TEXT, uid TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, nick TEXT, color TEXT)');
  try { db.run('ALTER TABLE queue ADD COLUMN uid TEXT'); } catch {}  // database written by a version without users
  try { db.run('ALTER TABLE users ADD COLUMN color TEXT'); } catch {} // ...or without colours
  return db;
}

export const load = (db: Database) => db.query('SELECT key, id, title, uid FROM queue ORDER BY pos').all() as Song[];

export const loadUsers = (db: Database) =>
  new Map(
    (db.query('SELECT uid, nick, color FROM users').all() as { uid: string; nick: string | null; color: string | null }[])
      .map(u => [u.uid, { nick: u.nick ?? undefined, color: u.color ?? undefined }] as const),
  );

export const saveUser = (db: Database, uid: string, me: User) =>
  db.run(
    'INSERT INTO users (uid, nick, color) VALUES (?, ?, ?) ON CONFLICT(uid) DO UPDATE SET nick = excluded.nick, color = excluded.color',
    [uid, me.nick ?? null, me.color ?? null],
  );

/** The queue is short, so rewrite it whole — cheaper than tracking individual rows.
 *  ponytail: full table rewrite; switch to targeted INSERT/DELETE if it ever grows to hundreds of songs. */
export const save = (db: Database, songs: Song[]) =>
  db.transaction(() => {
    db.run('DELETE FROM queue');
    const ins = db.prepare('INSERT INTO queue (pos, key, id, title, uid) VALUES (?, ?, ?, ?, ?)');
    songs.forEach((s, i) => ins.run(i, s.key, s.id, s.title, s.uid ?? null));
  })();

type Handler = (req: Request, srv: Bun.Server) => Response | undefined | Promise<Response | undefined>;

/** Wraps every handler at once: add a route and its log line appears for free, nothing duplicated by hand. */
function logged<T extends Record<string, unknown>>(routes: T): T {
  const wrap = (path: string, fn: Handler): Handler => async (req, srv) => {
    const t = performance.now();
    const body = req.method === 'POST' ? await req.clone().text() : new URL(req.url).search.slice(1);
    try {
      const res = await fn(req, srv);
      log(`${req.method} ${path} ${body} → ${res?.status ?? '—'} ${Math.round(performance.now() - t)}ms, в очереди ${queue.length}`);
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
  const db = openDB();
  queue.push(...load(db)); // whatever survived the restart; empty on a fresh database
  loadUsers(db).forEach((me, uid) => users.set(uid, me));
  const port = Number(process.env.PORT ?? 8765);
  const url = lanURL(port);
  const qr = await QRCode.toString(url, { type: 'svg', margin: 2, color: { light: '#fff' } });

  const server = Bun.serve({
    port,
    hostname: '0.0.0.0', // otherwise phones on the same network cannot reach it
    routes: logged({
      '/': index,
      '/qr.svg': () => new Response(qr, { headers: { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' } }),
      '/queue': () => json(withUsers(queue)),
      '/add': {
        POST: async req => {
          const p = new URL(req.url).searchParams;
          await add(await req.text(), p.get('title') ?? undefined, p.get('uid')?.slice(0, 64));
          return push();
        },
      },
      '/me': {
        POST: async req => {
          const p = new URL(req.url).searchParams;
          const uid = p.get('uid')?.slice(0, 64);
          if (!uid) return new Response('нужен uid', { status: 400 });
          saveUser(db, uid, setMe(uid, p.get('nick') ?? undefined, p.get('color') ?? undefined));
          return push(); // everyone's copy of the queue shows the new name right away
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
      open: ws => (ws.subscribe('queue'), ws.send(JSON.stringify(withUsers(queue))), log('ws + подключился')), // a new guest sees the queue right away
      close: () => log('ws − отключился'),
      message: () => {},
    },
  });

  /** Broadcast the queue to everyone and answer the caller with it. */
  const push = () => {
    save(db, queue);
    const shown = withUsers(queue);
    server.publish('queue', JSON.stringify(shown));
    return json(shown);
  };

  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  console.log(`экран: http://127.0.0.1:${port}   телефоны: ${url}`);
  console.log(`база: ${process.env.KARA_DB ?? 'kara.db'}, песен в очереди: ${queue.length}`);
}
