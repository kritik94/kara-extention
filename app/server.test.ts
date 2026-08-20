import { expect, test } from 'bun:test';
import { ids, queue, skip, remove, pickVideos, add, searchURL, openDB, load, save } from './server';

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
  skip(); // пустая очередь не падает после очистки ниже
});

test('remove по ключу переживает сдвиг очереди', () => {
  queue.length = 0;
  queue.push({ key: 'k1', id: 'a', title: 'A' }, { key: 'k2', id: 'b', title: 'B' }, { key: 'k3', id: 'c', title: 'C' });
  queue.shift();                       // кто-то допел, индексы уехали
  remove('k3');                        // гость целился в третью — попал в неё, а не в соседа
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
});

test('галочка «только караоке» дописывает слово к запросу', () => {
  expect(decodeURIComponent(searchURL('цой звезда', true))).toEndWith('цой звезда karaoke');
  expect(decodeURIComponent(searchURL('цой звезда', false))).toEndWith('цой звезда');
});

test('очередь переживает перезапуск: порядок и поля сохраняются', () => {
  const db = openDB(':memory:');
  const songs = [
    { key: 'k1', id: 'aaaaaaaaaaa', title: 'Первая' },
    { key: 'k2', id: 'bbbbbbbbbbb', title: 'Вторая' },
  ];
  save(db, songs);
  expect(load(db)).toEqual(songs);

  save(db, [songs[1]]); // спели первую — в базе остаётся только вторая, а не обе
  expect(load(db)).toEqual([songs[1]]);
});
