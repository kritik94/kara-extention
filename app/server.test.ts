import { expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { ids, list, history, skip, remove, promote, setGen, setting, setSetting, pickVideos, add, searchURL, openDB, use, newSession, users, setMe, withUsers, loadUsers, saveUser } from './server';

use(openDB(':memory:'));

let seq = 0;
const put = async (uid: string, n = 1) => {
  for (let i = 0; i < n; i++) await add('https://youtu.be/' + String(seq++).padStart(11, 'v'), 'песня', uid);
};
const uids = () => list().map(s => s.uid).join('');
const gens = () => list().map(s => `${s.uid}${s.gen}`).join(' ');
/** Plays the queue on until uid has sung: the id says the song ended by itself, not by the button. */
const singUntil = (uid: string) => {
  while (list().length && list()[0].uid !== uid) skip(list()[0].id);
  skip(list()[0]?.id);
};

test('ids: watch, youtu.be с таймкодом, shorts; мусор мимо', () => {
  expect(ids('https://www.youtube.com/watch?v=TlOyQVkQFAM\nhttps://youtu.be/M8cWMUPTNbw&t=5\nтекст')).toEqual([
    'TlOyQVkQFAM',
    'M8cWMUPTNbw',
  ]);
});

test('skip закрывает голову только если id совпал', async () => {
  newSession();
  await put('u1', 2);
  const [head, next] = list();
  skip('чужой');
  expect(list()[0].id).toBe(head.id); // the screen was late: the head is not someone else's to close
  skip(head.id);
  expect(list().map(s => s.id)).toEqual([next.id]);
  skip(next.id);
  skip(); // an empty stage must not throw
  expect(list()).toEqual([]);
});

test('remove по ключу, а не по позиции: очередь под руками уехала', async () => {
  newSession();
  await put('u1', 3);
  const [, , third] = list();
  skip(list()[0].id);  // someone finished singing, positions shifted
  remove(third.key);   // the guest aimed at the third song and hit it, not its neighbour
  expect(list().map(s => s.key)).toEqual([list()[0].key]);
  remove('такого-нет');
  expect(list()).toHaveLength(1);
});

test('pickVideos достаёт видео из вложенного дерева', () => {
  const data = { x: [{ videoRenderer: { videoId: 'RJKhHLuUJp0', title: { runs: [{ text: 'Песня' }] } } }, { junk: 1 }] };
  expect(pickVideos(data)).toEqual([{ id: 'RJKhHLuUJp0', title: 'Песня' }]);
});

test('add берёт готовое название от поиска, не ходя в oembed', async () => {
  newSession();
  await add('https://youtu.be/dQw4w9WgXcQ', 'Виктор Цой — Звезда (Караоке)', 'u1');
  expect(list()[0]).toMatchObject({ id: 'dQw4w9WgXcQ', title: 'Виктор Цой — Звезда (Караоке)', uid: 'u1' });
  expect(list()[0].key).toHaveLength(8);
});

test('имя и цвет берутся у пользователя: переименовался — обновились все его песни', async () => {
  newSession();
  users.clear();
  await add('https://youtu.be/dQw4w9WgXcQ', 'Первая', 'u1');
  await add('https://youtu.be/M8cWMUPTNbw', 'Вторая', 'u1');
  await add('https://youtu.be/TlOyQVkQFAM', 'Чужая', 'u2');
  expect(withUsers(list()).map(s => s.nick)).toEqual([undefined, undefined, undefined]); // никто не назвался

  setMe('u1', '  ' + 'я'.repeat(40), '#38BDF8'); // имя обрезается: maxLength в браузере не граница
  expect(withUsers(list()).map(s => s.nick)).toEqual(['я'.repeat(24), 'я'.repeat(24), undefined]);
  expect(withUsers(list()).map(s => s.color)).toEqual(['#38BDF8', '#38BDF8', undefined]);

  setMe('u1', '', 'red; content: url(зло)'); // цвет уезжает в style на экране — пускаем только чистый hex
  expect(withUsers(list())[0]).toMatchObject({ nick: undefined, color: undefined });
});

test('поколения: пачка от одного растягивается, новичок ждёт одно поколение', async () => {
  newSession();
  setGen(3);
  await put('A', 8);
  expect(uids()).toBe('AAAAAAAA'); // никого больше нет — поколения ничего не значат
  expect(list().map(s => s.gen).join('')).toBe('00011122');

  await put('B'); // Б пришёл, когда А уже поставил восемь
  expect(uids()).toBe('AAABAAAAA'); // ждёт три песни, а не восемь

  await put('C'); // В — следом за Б, в то же поколение
  expect(uids()).toBe('AAABCAAAAA');

  await put('A'); // своя новая песня не лезет вперёд своих же
  expect(uids()).toBe('AAABCAAAAAA');
});

test('смена настройки не трогает уже поставленное, а работает на следующей песне', async () => {
  newSession();
  setGen(3);
  await put('A', 4);
  await put('B');
  const before = uids();

  setGen(1);
  expect(uids()).toBe(before); // очередь не шелохнулась

  await put('C'); // новичок всё равно попадает в нулевое поколение, за Б
  await put('A'); // а вот А по новому правилу: в поколении 1 у него уже есть песня, значит поколение 2
  expect(gens()).toBe('A0 A0 A0 B0 C0 A1 A2');
  expect(uids().startsWith('AAAB')).toBe(true); // три А подряд из старого поколения так и остались подряд
});

test('ноль выключает честность: очередь снова простая', async () => {
  newSession();
  setGen(0);
  await put('A', 3);
  await put('B');
  await put('A');
  expect(uids()).toBe('AAABA'); // кто раньше добавил, тот раньше и поёт
  setGen(3);
});

test('свободный режим не прощает налитого: вернули честность — очередь помнит', async () => {
  newSession();
  setGen(0);
  await put('A', 6); // налил, пока честность была выключена
  await put('B');
  setGen(3);
  await put('B'); // у Б за вечер одна песня, у А шесть
  await put('A');
  expect(gens().endsWith('B0 B0 A1')).toBe(true); // Б ещё в текущем поколении, А уже за всей своей пачкой
});

test('спел — и снова второй: сыгранное продолжает считаться', async () => {
  newSession();
  setGen(3);
  await put('A', 9); // A залил девять
  await put('B');    // B встал честно, ждёт три
  expect(uids()).toBe('AAABAAAAAA');

  singUntil('B');
  await put('B'); // своих песен в очереди нет — но и права начать сначала тоже
  expect(list().findIndex(s => s.uid === 'B')).toBeGreaterThan(1); // не второй

  singUntil('B');
  await put('B', 3); // и целое поколение вперёд не забрать
  expect(list().slice(1, 4).every(s => s.uid === 'B')).toBe(false);
});

test('чужой новичок встаёт в конец текущего поколения, а не в голову', async () => {
  newSession();
  setGen(3);
  await put('A', 9);
  while (list()[0].gen === 0) skip(list()[0].id); // первое поколение отпели
  await put('новичок');                           // хоть свежий uid, хоть настоящий гость — правило одно
  expect(gens()).toBe('A1 A1 A1 новичок1 A2 A2 A2');
});

test('поющую песню не обгоняет никто', async () => {
  newSession();
  setGen(3);
  await put('A');
  const head = list()[0];
  await put('B', 2);
  setGen(0);
  await put('C');
  expect(list()[0].key).toBe(head.key); // ни честный новичок, ни свободный режим голову не двигают
  setGen(3);
});

test('удалил свою — слот в поколении вернулся', async () => {
  newSession();
  setGen(3);
  await put('A', 3);
  await put('B');
  remove(list()[2].key); // третья песня А больше не занимает место в поколении
  await put('A');
  expect(gens()).toBe('A0 A0 B0 A0'); // новая села в освободившийся слот, а не уехала в следующее поколение
});

test('новый вечер обнуляет счёт, старый остаётся в истории', async () => {
  newSession();
  setGen(3);
  await put('A', 6);
  const was = history().length;
  newSession();
  await put('A', 3);
  await put('B');
  expect(uids()).toBe('AAAB'); // A начинает с нуля, а не с шестого поколения
  expect(history()).toHaveLength(4); // прошлый вечер сюда не заглядывает
  expect(was).toBe(6);
});

test('история помнит спетое, пропущенное и выброшенное', async () => {
  newSession();
  setGen(3);
  await put('A', 4);
  skip(list()[0].id);    // доиграла сама
  skip();                // а эту пропустили кнопкой
  remove(list()[1].key); // ожидающую выбросили
  expect(history().map(s => s.status)).toEqual(['played', 'skipped', 'playing', 'removed']);
});

test('история знает, когда песня ушла со сцены', async () => {
  newSession();
  setGen(3);
  await put('A', 2);
  const before = Date.now();
  skip(list()[0].id);
  const [sung, waiting] = history();
  expect(sung.done).toBeGreaterThanOrEqual(before); // время ухода, а не добавления
  expect(waiting.done).toBeNull();                  // ещё в очереди — уходить не откуда
});

test('снять с телефона играющую — это пропуск, и он считается', async () => {
  newSession();
  setGen(3);
  await put('A', 3);
  await put('B');
  remove(list()[0].key); // А снимает свою прямо со сцены, чтобы место в поколении не тратилось
  await put('A');
  expect(history()[0].status).toBe('skipped');
  expect(gens()).toBe('A0 A0 B0 A1'); // не вышло: спетое — спетое, новая уходит в следующее поколение
});

test('новый вечер закрывает сцену старого', async () => {
  newSession();
  setGen(3);
  await put('A');
  newSession();
  expect(list()).toEqual([]);
});

test('настройка переживает перезапуск', () => {
  use(openDB(':memory:'));
  expect(setting('gen')).toBeUndefined(); // база о ней ещё не слышала — остаётся значение по умолчанию
  setSetting('gen', '5');
  setSetting('gen', '2'); // вторую строку не плодит
  expect(setting('gen')).toBe('2');
});

test('пользователи переживают перезапуск', () => {
  use(openDB(':memory:'));
  saveUser('u1', { nick: 'Никита', color: '#f87171' });
  saveUser('u1', { nick: 'Ник' }); // переименование не плодит вторую строку и сбрасывает цвет
  saveUser('u2', { nick: 'Гость', color: '#4ade80' });
  expect(loadUsers()).toEqual(
    new Map([
      ['u1', { nick: 'Ник', color: undefined }],
      ['u2', { nick: 'Гость', color: '#4ade80' }],
    ]),
  );
});

test('галочка «только караоке» дописывает слово к запросу', () => {
  expect(decodeURIComponent(searchURL('цой звезда', true))).toEndWith('цой звезда karaoke');
  expect(decodeURIComponent(searchURL('цой звезда', false))).toEndWith('цой звезда');
});

test('очередь старой версии переезжает в историю нового формата', () => {
  const path = `${process.env.TMPDIR ?? '/tmp'}/kara-migrate-${Date.now()}.db`;
  const old = openDB(path);
  old.run('DROP TABLE songs');
  old.run('CREATE TABLE queue (pos INTEGER PRIMARY KEY, key TEXT, id TEXT, title TEXT)'); // ни uid, ни gen
  old.run("INSERT INTO queue VALUES (0, 'k1', 'a', 'Первая'), (1, 'k2', 'b', 'Вторая')");
  old.close();

  use(openDB(path)); // тот же файл, но версией с историей
  promote();         // старт сервера ставит голову на сцену
  expect(list().map(s => `${s.uid}${s.gen}:${s.title}`)).toEqual(['гость0:Первая', 'гость0:Вторая']);
  expect(history().map(s => s.status)).toEqual(['playing', 'queued']); // первая сразу на сцене
  unlinkSync(path);
});

test('переезд не перетасовывает очередь, которую люди уже видят', () => {
  const path = `${process.env.TMPDIR ?? '/tmp'}/kara-migrate-${Date.now()}.db`;
  const old = openDB(path);
  old.run('DROP TABLE songs');
  old.run('CREATE TABLE queue (pos INTEGER PRIMARY KEY, key TEXT, id TEXT, title TEXT, uid TEXT, gen INTEGER)');
  // старая версия при выключенной честности дописывала в хвост с нулевым поколением — позади первого и второго
  old.run("INSERT INTO queue VALUES (0,'k1','a','1','A',0), (1,'k2','b','2','A',1), (2,'k3','c','3','A',2), (3,'k4','d','4','B',0)");
  old.close();

  use(openDB(path));
  expect(list().map(s => s.title).join('')).toBe('1234'); // тот же порядок, что был на экране
  unlinkSync(path);
});
