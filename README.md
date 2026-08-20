# Kara Queue

Простой караоке-сервис для компании: гости добавляют YouTube-видео в общую очередь, а Chrome-расширение на экране у телевизора автоматически проигрывает их по порядку.

## Что внутри

- `app/` — Bun-сервер и веб-интерфейс для гостей
- `extension/` — Chrome-расширение для управления очередью на YouTube
- `docs/` — заметки и описание MVP

## Быстрый старт

1. Установите [Bun](https://bun.sh/).
2. В `/home/runner/work/kara-extention/kara-extention/app` выполните `bun install`.
3. Запустите сервер: `bun run start`.
4. Загрузите папку `/home/runner/work/kara-extention/kara-extention/extension` как unpacked extension в Chrome.
5. Откройте YouTube на экране и страницу сервера на телефоне из локальной сети.

По умолчанию сервер работает на `http://127.0.0.1:8765`.
