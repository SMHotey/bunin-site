# HANDOFF — состояние проекта

**Проект:** сайт о Иване Бунине (poet-bunin.ru)
**Папка:** `C:\Users\malik\bunin-site`
**Обновлено:** 09 ноября 2026

---

## 0. Состояние на 9 ноября 2026

Сайт опубликован: GitHub Pages + `poet-bunin.ru`, DNS на Cloudflare, Enforce HTTPS,
Метрика 113966035, IndexNow активен.

SEO-прогон 9 ноября: гейты `seo:audit` / `content:coverage` / `links:orphans` /
`metrika:goals` (сетевые — отдельно от сборки), перелинковка «разбор ↔ текст»,
title/description/h1 хабов под запрос, приоритеты sitemap (publications 0.9, works 0.5),
IndexNow с приоритетом T1–T4, пять пилотных разборов школьной программы,
программа в `docs/SEO-PLAN.md`, итог — `docs/SEO-RESULTS-2026-11-09.md`.

Числа: sitemap 551, T1–T4 52 (57,1% описательных), доля works 83,5%, сирот 0,
`seo:audit` PASS 14 / FAIL 0 / SKIP 1 (GA4), `verify` PASS (1 предупреждение — очередь).

Дальше: следующий пакет разборов из плана. Очередь журнала на 2 будних дня из 14 —
из-за этого `verify:strict` даёт предупреждение, лечится только написанием статей.

Нужно от владельца: Measurement ID GA4, токены Метрики и Вебмастера, четыре цели
в кабинете Метрики (`book_click`, `audiobook_click`, `scroll_90`, `print`).

---

## 1. Стек

Node-сборка без зависимостей: `scripts/build.mjs` + `sections.mjs`, данные в `data/*.json`,
статьи в `content/*.md`. Проверка — `npm run verify` (сборка, ссылки, аудит текстов,
прод-проверки), норма 0 ошибок и 0 предупреждений. Деплой — пуш в `master`.
