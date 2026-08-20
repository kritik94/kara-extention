import index from './index.html';
import QRCode from 'qrcode';
import { nanoid } from 'nanoid';
import { Database } from 'bun:sqlite'; // встроен в Bun, отдельной зависимости не нужно
import { networkInterfaces } from 'node:os';
import list from '../docs/list.txt' with { type: 'text' }; // вшивается в бинарник при --compile

/** key — своя личность записи: одна песня может стоять в очереди дважды. */
export type Found = { id: string; title: string };          // результат поиска
export type Song = Found & { key: string };                 // запись в очереди
export const queue: Song[] = [];

export const ids = (text: string) =>
  [...text.matchAll(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/g)].map(m => m[1]);

export function skip(id?: string) {
  // id защищает от гонки: экран досмотрел A, а очередь уже уехала — не глотаем чужую песню
  if (queue.length && (!id || queue[0].id === id)) queue.shift();
}

export function remove(key: string) {
  const i = queue.findIndex(s => s.key === key);
  if (i >= 0) queue.splice(i, 1); // по ключу, а не по индексу: два гостя могут удалять одновременно
}

/** oembed: без ключа и без квоты, в отличие от Data API */
async function titleOf(id: string) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://youtu.be/${id}&format=json`);
    if (!r.ok) throw new Error(`oembed ${r.status}`); // 401 у видео с запретом встраивания, 429 при частых запросах
    return ((await r.json()) as { title: string }).title;
  } catch (e) {
    log(`название для ${id} не добылось (${e}), показываю id`);
    return id;
  }
}

/** title передаёт тот, кто его уже знает (поиск) — тогда лишнего похода в oembed не будет. */
export const add = async (text: string, title?: string) => {
  const found = ids(text);
  return queue.push(
    ...(await Promise.all(
      found.map(async id => ({
        key: nanoid(8),
        id,
        title: title && found.length === 1 ? title : await titleOf(id),
      })),
    )),
  );
};

/** Разбор ytInitialData поиском по дереву: переживает перестановку блоков на странице. */
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

/** Адрес, по которому телефоны в той же сети откроют страницу. 127.0.0.1 им бесполезен. */
export function lanURL(port: number) {
  const ip = Object.values(networkInterfaces())
    .flat()
    .find(i => i?.family === 'IPv4' && !i.internal)?.address;
  return `http://${ip ?? '127.0.0.1'}:${port}`;
}

/** Файл рядом с исполняемым: запустил kara.exe в папке — там же и появится kara.db. */
export function openDB(path = process.env.KARA_DB ?? 'kara.db') {
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE IF NOT EXISTS queue (pos INTEGER PRIMARY KEY, key TEXT, id TEXT, title TEXT)');
  return db;
}

export const load = (db: Database) => db.query('SELECT key, id, title FROM queue ORDER BY pos').all() as Song[];

/** Очередь короткая, поэтому переписываем её целиком — дешевле, чем следить за отдельными строками.
 *  ponytail: перезапись всей таблицы; если очередь дорастёт до сотен песен, точечные INSERT/DELETE. */
export const save = (db: Database, songs: Song[]) =>
  db.transaction(() => {
    db.run('DELETE FROM queue');
    const ins = db.prepare('INSERT INTO queue (pos, key, id, title) VALUES (?, ?, ?, ?)');
    songs.forEach((s, i) => ins.run(i, s.key, s.id, s.title));
  })();

type Handler = (req: Request, srv: Bun.Server) => Response | undefined | Promise<Response | undefined>;

/** Оборачивает все хендлеры разом: добавить ручку — лог появится сам, руками ничего не дублируем. */
function logged<T extends Record<string, unknown>>(routes: T): T {
  const wrap = (path: string, fn: Handler): Handler => async (req, srv) => {
    const t = performance.now();
    const body = req.method === 'POST' ? await req.clone().text() : new URL(req.url).search.slice(1);
    try {
      const res = await fn(req, srv);
      log(`${req.method} ${path} ${body} → ${res?.status ?? '—'} ${Math.round(performance.now() - t)}ms, в очереди ${queue.length}`);
      return res;
    } catch (e) {
      log(`${req.method} ${path} ${body} → упал: ${e}`); // лог и дальше наверх, ответ 500 отдаст Bun
      throw e;
    }
  };
  return Object.fromEntries(
    Object.entries(routes).map(([path, h]) => [
      path,
      typeof h === 'function' ? wrap(path, h as Handler)
      : isMethods(h) ? Object.fromEntries(Object.entries(h).map(([m, fn]) => [m, wrap(path, fn as Handler)]))
      : h, // index.html — это HTMLBundle, Bun отдаёт его сам
    ]),
  ) as T;
}

/** Именно по именам методов: у HTMLBundle своих ключей нет, и «все значения — функции» на нём даёт true. */
const isMethods = (h: unknown): h is Record<string, Handler> =>
  !!h && typeof h === 'object' && Object.keys(h).length > 0 &&
  Object.keys(h).every(k => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(k));

const log = (msg: string) => console.log(`${new Date().toLocaleTimeString('ru')}  ${msg}`);

const json = (data: unknown) =>
  Response.json(data, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });

if (import.meta.main) {
  const db = openDB();
  const restored = load(db);
  if (restored.length) queue.push(...restored); // очередь пережила перезапуск
  else await add(list); // первый запуск на чистой базе — берём стартовый список
  const port = Number(process.env.PORT ?? 8765);
  const url = lanURL(port);
  const qr = await QRCode.toString(url, { type: 'svg', margin: 2, color: { light: '#fff' } });

  const server = Bun.serve({
    port,
    hostname: '0.0.0.0', // иначе телефоны в той же сети не достучатся
    routes: logged({
      '/': index,
      '/qr.svg': () => new Response(qr, { headers: { 'Content-Type': 'image/svg+xml', 'Access-Control-Allow-Origin': '*' } }),
      '/queue': () => json(queue),
      '/add': { POST: async req => (await add(await req.text(), new URL(req.url).searchParams.get('title') ?? undefined), push()) },
      '/skip': { POST: async req => (skip((await req.text()) || undefined), push()) },
      '/remove': { POST: async req => (remove(await req.text()), push()) },
      '/search': async req => {
        const p = new URL(req.url).searchParams;
        return json(await search(p.get('q') ?? '', p.get('karaoke') !== '0'));
      },
    }),
    // Состояние раздаём по сокету, действия остаются обычным RPC поверх POST
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response('404', { status: 404 })),
    websocket: {
      open: ws => (ws.subscribe('queue'), ws.send(JSON.stringify(queue)), log('ws + подключился')), // новый гость сразу видит очередь
      close: () => log('ws − отключился'),
      message: () => {},
    },
  });

  /** Разослать очередь всем и ответить инициатору тем же. */
  const push = () => (save(db, queue), server.publish('queue', JSON.stringify(queue)), json(queue));

  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  console.log(`экран: http://127.0.0.1:${port}   телефоны: ${url}`);
  console.log(`база: ${process.env.KARA_DB ?? 'kara.db'}${restored.length ? ' (очередь восстановлена)' : ''}`);
  console.log('очередь:', queue.map(s => s.title));
}
