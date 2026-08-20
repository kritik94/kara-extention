import { expect, test } from 'bun:test';
import { ids, queue, skip, remove, pickVideos, add, searchURL, openDB, load, save, users, setMe, withUsers, loadUsers, saveUser } from './server';

test('ids: watch, youtu.be с таймкодом, shorts; мусор мимо', () => {
  expect(ids('https://www.youtube.com/watch?v=TlOyQVkQFAM\nhttps://youtu.be/M8cWMUPTNbw&t=5\nтекст')).toEqual([
    'TlOyQVkQFAM',
    'M8cWMUPTNbw',
  ]);
});

test('skip снимает голову только если id совпал', () => {
  queue.push({ key: 'k1', id: 'a', title: 'A' }, { key: 'k2', id: 'b', title: 'B' });
  skip('чужой');
  expect(queue.length).toBe(2);
  skip('a');
  expect(queue.map(s => s.id)).toEqual(['b']);
  skip(); // an empty queue must not throw
});

test('remove по ключу переживает сдвиг очереди', () => {
  queue.length = 0;
  queue.push({ key: 'k1', id: 'a', title: 'A' }, { key: 'k2', id: 'b', title: 'B' }, { key: 'k3', id: 'c', title: 'C' });
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
  await add('https://youtu.be/dQw4w9WgXcQ', 'Виктор Цой — Звезда (Караоке)');
  expect(queue[0]).toMatchObject({ id: 'dQw4w9WgXcQ', title: 'Виктор Цой — Звезда (Караоке)' });
  expect(queue[0].key).toHaveLength(8);
  expect(queue[0].uid).toBeUndefined(); // uid добровольный: старый клиент его не шлёт
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
    { key: 'k1', id: 'aaaaaaaaaaa', title: 'Первая', uid: 'u1' },
    { key: 'k2', id: 'bbbbbbbbbbb', title: 'Вторая', uid: null },
  ];
  save(db, songs);
  expect(load(db)).toEqual(songs as any);

  save(db, [songs[1]]); // first song is done: only the second one stays, not both
  expect(load(db)).toEqual([songs[1]]);
});
