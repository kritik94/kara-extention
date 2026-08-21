import { expect, test } from 'bun:test';
import { ids, queue, skip, remove, place, setGen, loadGen, saveGen, pickVideos, add, searchURL, openDB, load, save, users, setMe, withUsers, loadUsers, saveUser } from './server';

test('ids: watch, youtu.be с таймкодом, shorts; мусор мимо', () => {
  expect(ids('https://www.youtube.com/watch?v=TlOyQVkQFAM\nhttps://youtu.be/M8cWMUPTNbw&t=5\nтекст')).toEqual([
    'TlOyQVkQFAM',
    'M8cWMUPTNbw',
  ]);
});

test('skip снимает голову только если id совпал', () => {
  queue.push({ key: 'k1', id: 'a', title: 'A', uid: 'u1', gen: 0 }, { key: 'k2', id: 'b', title: 'B', uid: 'u1', gen: 0 });
  skip('чужой');
  expect(queue.length).toBe(2);
  skip('a');
  expect(queue.map(s => s.id)).toEqual(['b']);
  skip(); // an empty queue must not throw
});

test('remove по ключу переживает сдвиг очереди', () => {
  queue.length = 0;
  queue.push({ key: 'k1', id: 'a', title: 'A', uid: 'u1', gen: 0 }, { key: 'k2', id: 'b', title: 'B', uid: 'u1', gen: 0 }, { key: 'k3', id: 'c', title: 'C', uid: 'u1', gen: 0 });
  queue.shift();                       // someone finished singing, indices shifted
  remove('k3');                        // the guest aimed at the third song and hit it, not its neighbour
  expect(queue.map(s => s.id)).toEqual(['b']);
  remove('такого-нет');
  expect(queue.length).toBe(1);
});

test('pickVideos достаёт видео из вложенного дерева', () => {
  const data = { x: [{ videoRenderer: { videoId: 'RJKhHLuUJp0', title: { runs: [{ text: 'Песня' }] } } }, { junk: 1 }] };
  expect(pickVideos(data)).toEqual([{ id: 'RJKhHLuUJp0', title: 'Песня' }]);
});

test('add берёт готовое название от поиска, не ходя в oembed', async () => {
  queue.length = 0;
  await add('https://youtu.be/dQw4w9WgXcQ', 'Виктор Цой — Звезда (Караоке)', 'u1');
  expect(queue[0]).toMatchObject({ id: 'dQw4w9WgXcQ', title: 'Виктор Цой — Звезда (Караоке)', uid: 'u1' });
  expect(queue[0].key).toHaveLength(8);
});

test('имя и цвет берутся у пользователя: переименовался — обновились все его песни', async () => {
  queue.length = 0;
  users.clear();
  await add('https://youtu.be/dQw4w9WgXcQ', 'Первая', 'u1');
  await add('https://youtu.be/M8cWMUPTNbw', 'Вторая', 'u1');
  await add('https://youtu.be/TlOyQVkQFAM', 'Чужая', 'u2');
  expect(withUsers(queue).map(s => s.nick)).toEqual([undefined, undefined, undefined]); // никто не назвался

  setMe('u1', '  ' + 'я'.repeat(40), '#38BDF8'); // имя обрезается: maxLength в браузере не граница
  expect(withUsers(queue).map(s => s.nick)).toEqual(['я'.repeat(24), 'я'.repeat(24), undefined]);
  expect(withUsers(queue).map(s => s.color)).toEqual(['#38BDF8', '#38BDF8', undefined]);

  setMe('u1', '', 'red; content: url(зло)'); // цвет уезжает в style на экране — пускаем только чистый hex
  expect(withUsers(queue)[0]).toMatchObject({ nick: undefined, color: undefined });
});

test('пользователи переживают перезапуск', () => {
  const db = openDB(':memory:');
  saveUser(db, 'u1', { nick: 'Никита', color: '#f87171' });
  saveUser(db, 'u1', { nick: 'Ник' }); // переименование не плодит вторую строку и сбрасывает цвет
  saveUser(db, 'u2', { nick: 'Гость', color: '#4ade80' });
  expect(loadUsers(db)).toEqual(
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

test('очередь переживает перезапуск: порядок и поля сохраняются', () => {
  const db = openDB(':memory:');
  const songs = [
    { key: 'k1', id: 'aaaaaaaaaaa', title: 'Первая', uid: 'u1', gen: 0 },
    { key: 'k2', id: 'bbbbbbbbbbb', title: 'Вторая', uid: 'u2', gen: 1 },
  ];
  save(db, songs);
  expect(load(db)).toEqual(songs as any);

  save(db, [songs[1]]); // first song is done: only the second one stays, not both
  expect(load(db)).toEqual([songs[1]]);
});

let seq = 0;
const put = async (uid: string, n = 1) => {
  for (let i = 0; i < n; i++) await add('https://youtu.be/' + String(seq++).padStart(11, 'v'), 'песня', uid);
};
const uids = () => queue.map(s => s.uid).join('');

test('поколения: пачка от одного растягивается, новичок ждёт одно поколение', async () => {
  queue.length = 0;
  setGen(3);
  await put('A', 8);
  expect(uids()).toBe('AAAAAAAA'); // никого больше нет — поколения ничего не значат
  expect(queue.map(s => s.gen).join('')).toBe('00011122');

  await put('B'); // Б пришёл, когда А уже поставил восемь
  expect(uids()).toBe('AAABAAAAA'); // ждёт три песни, а не восемь

  await put('C'); // В — следом за Б, в то же поколение
  expect(uids()).toBe('AAABCAAAAA');

  await put('A'); // своя новая песня не лезет вперёд своих же
  expect(uids()).toBe('AAABCAAAAAA');
});

test('смена настройки не трогает уже поставленное, а работает на следующей песне', async () => {
  queue.length = 0;
  setGen(3);
  await put('A', 4);
  await put('B');
  const before = uids();

  setGen(1);
  expect(uids()).toBe(before); // очередь не шелохнулась

  await put('C'); // новичок всё равно попадает в нулевое поколение, за Б
  await put('A'); // а вот А по новому правилу: в поколении 1 у него уже есть песня, значит поколение 2
  expect(queue.map(s => `${s.uid}${s.gen}`).join(' ')).toBe('A0 A0 A0 B0 C0 A1 A2');
  expect(uids().startsWith('AAAB')).toBe(true); // три А подряд из старого поколения так и остались подряд
});

test('ноль выключает честность: очередь снова простая', async () => {
  queue.length = 0;
  setGen(0);
  await put('A', 3);
  await put('B');
  await put('A');
  expect(uids()).toBe('AAABA'); // кто раньше добавил, тот раньше и поёт
  setGen(3);
});

test('настройка переживает перезапуск', () => {
  const db = openDB(':memory:');
  expect(loadGen(db)).toBeNaN(); // база о ней ещё не слышала — остаётся значение по умолчанию
  saveGen(db, 5);
  saveGen(db, 2); // вторую строку не плодит
  expect(loadGen(db)).toBe(2);
});
