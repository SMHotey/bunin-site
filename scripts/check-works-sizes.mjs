#!/usr/bin/env node
// Сверка текстов библиотеки с оригиналами на Викитеке: не обрезан ли текст.
//
// Смысл: библиотека собрана импортом, и часть вещей могла приехать не целиком —
// обрыв на середине, потеря последних строф, чужой фрагмент вместо полного текста.
// Глазами это не видно: страница выглядит законченной. Поэтому считаем размеры.
//
// Как работает: для каждого произведения берётся `sourceUrl`, страница Викитеки
// рендерится через API (`action=parse`), из HTML вынимается текст, после чего
// сравниваются словарные последовательности. Три признака:
//   • prefix — наш текст целиком входит в оригинал и короче его → обрезан;
//   • tail   — последние слова оригинала есть у нас → текст целый;
//   • head   — первые слова совпадают (иначе это другое издание/перевод).
//
// Запуск: node scripts/check-works-sizes.mjs            — все произведения
//         node scripts/check-works-sizes.mjs --limit 20 — первые 20 (проба)
//         node scripts/check-works-sizes.mjs --fresh    — начать отчёт заново
// Отчёт: reports/works-size-report.json (пишется после каждого произведения,
// повторный запуск докачивает недостающее, а не начинает сначала).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const REPORT_DIR = join(ROOT, 'reports');
const REPORT = join(REPORT_DIR, 'works-size-report.json');
const args = process.argv.slice(2);
const limit = Number(args[args.indexOf('--limit') + 1]) || 0;
const fresh = args.includes('--fresh');
const DELAY_MS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'poet-bunin.ru/1.0 (educational site; library size check)';

// Служебные элементы страницы Викитеки: карточка «О тексте», навигация, сноски,
// меню, категории. Их текст не относится к произведению.
const SKIP_CLASS = /(ws-noexport|headertemplate|navbox|catlinks|references|mw-editsection|toc|ws-notes|ws-header|proofreadpage|license|ws-footer|ws-toolbar|noprint)/i;

function plain(html) {
  const h = String(html);
  const out = [];
  let i = 0;
  let skip = 0;            // глубина вложенности «служебного» блока
  let skipTag = null;      // на каком теге сидим
  while (i < h.length) {
    const lt = h.indexOf('<', i);
    if (lt < 0) { if (!skip) out.push(h.slice(i)); break; }
    if (lt > i && !skip) out.push(h.slice(i, lt));
    const gt = h.indexOf('>', lt);
    if (gt < 0) break;
    const tag = h.slice(lt, gt + 1);
    i = gt + 1;
    if (/^<!--/.test(tag)) { const e = h.indexOf('-->', lt); i = e < 0 ? h.length : e + 3; continue; }
    const m = tag.match(/^<\/?\s*([a-zA-Z0-9]+)/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const closing = /^<\//.test(tag);
    const selfClosing = /\/>$/.test(tag) || ['br', 'hr', 'img', 'meta', 'link', 'input', 'wbr'].includes(name);
    if (skip) {
      if (!closing && !selfClosing && name === skipTag) skip += 1;
      else if (closing && name === skipTag) skip -= 1;
      if (skip <= 0) { skip = 0; skipTag = null; }
      continue;
    }
    if (!closing && !selfClosing && (name === 'style' || name === 'script'
      || SKIP_CLASS.test(tag) || /id="(headertemplate|catlinks|ws-footer)"/.test(tag))) {
      skip = 1;
      skipTag = name;
      continue;
    }
    out.push(' ');
  }
  return out.join(' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}




const words = (s) => plain(s).toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/i).filter(Boolean);

// В библиотеке текст часто начинается с названия и номера части («АНТОНОВСКИЕ ЯБЛОКИ»,
// «I»), а на странице Викитеки название стоит в шапке. Без снятия этих строк
// выравнивание не находит начало и текст выглядит «не совпадающим с оригиналом».
function stripLeadMarks(text, title) {
  const lines = String(text || '').split('\n').map((l) => l.trim());
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]/g, '');
  const t = norm(title);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) { i += 1; continue; }
    const n = norm(line);
    if (n && (n === t || /^[ivx]+$/.test(n) || /^\d+$/.test(n))) { i += 1; continue; }
    break;
  }
  return lines.slice(i).join('\n');
}

// Слова обвязки страницы (карточка «О тексте», примечания, категории): после конца
// произведения их в оригинале много, и они не должны выглядеть как «продолжение».
const JUNK = new Set(['примечания', 'примечание', 'источник', 'источники', 'литература', 'категория',
  'категории', 'файл', 'шаблон', 'править', 'обсуждение', 'история', 'бунин', 'иван', 'алексеевич',
  'собрание', 'сочинений', 'том', 'страница', 'навигация', 'содержание', 'далее', 'библиотека',
  'викитека', 'публикация', 'текст', 'перевод', 'издание', 'стихотворения', 'рассказы', 'повести']);

// Выравнивание с пропусками: оригиналу разрешаем «вставлять» до 4 слов (номера
// строк, колонтитулы), нашему тексту — до 2, после чего требуем совпадения.
function align(ours, theirs) {
  const hay = theirs.join(' ');
  const findBlock = (n, offset = 0) => {
    if (ours.length < offset + n) return -1;
    const needle = ours.slice(offset, offset + n).join(' ');
    const at = hay.indexOf(needle);
    if (at < 0) return -1;
    return hay.slice(0, at).split(' ').filter(Boolean).length;
  };
  let j = -1;
  let startOffset = 0;
  for (const [n, offset] of [[8, 0], [6, 0], [4, 0], [4, 1], [4, 2], [4, 3]]) {
    j = findBlock(n, offset);
    if (j >= 0) { startOffset = offset; break; }
  }
  let i = startOffset;
  let matched = 0;
  while (i < ours.length && j < theirs.length && j >= 0) {
    if (ours[i] === theirs[j]) { matched += 1; i += 1; j += 1; continue; }
    let resync = false;
    for (let skip = 1; skip <= 30 && j + skip < theirs.length; skip += 1) {
      if (ours[i] === theirs[j + skip]) { j += skip; resync = true; break; }
    }
    if (resync) continue;
    for (let skip = 1; skip <= 10 && i + skip < ours.length; skip += 1) {
      if (ours[i + skip] === theirs[j]) { i += skip; resync = true; break; }
    }
    if (resync) continue;
    i += 1;
    j += 1;
  }
  const rest = j < 0 ? theirs : theirs.slice(j);
  const tail = rest.filter((w) => w.length > 2 && !/^\d+$/.test(w) && !JUNK.has(w));
  return {
    found: j >= 0,
    covered: ours.length > startOffset ? +(matched / (ours.length - startOffset)).toFixed(3) : 0,
    tailWords: tail.length,
    tailSample: tail.slice(0, 12).join(' '),
  };
}


async function fetchOriginal(sourceUrl) {
  const m = String(sourceUrl).match(/^https?:\/\/ru\.wikisource\.org\/wiki\/(.+)$/);
  if (!m) return { error: 'не Викитека' };
  const title = decodeURIComponent(m[1]).replace(/_/g, ' ');
  const url = 'https://ru.wikisource.org/w/api.php?action=parse&format=json&formatversion=2&prop=text'
    + '&redirects=1&page=' + encodeURIComponent(title);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45000) });
    const raw = await res.text();
    if (raw.trimStart().startsWith('{')) {
      const data = JSON.parse(raw);
      if (data.error) return { error: data.error.code || 'ошибка API', title };
      return { title, html: data.parse?.text || '' };
    }
    if (/too many requests|429/i.test(raw)) { await sleep(12000 * (attempt + 1)); continue; }
    return { error: raw.slice(0, 120), title };
  }
  return { error: 'не удалось получить страницу (лимит запросов)', title };
}

const worksFile = JSON.parse(await readFile(join(ROOT, 'data', 'works.json'), 'utf8'));
const works = Array.isArray(worksFile) ? worksFile : (worksFile.works || []);
await mkdir(REPORT_DIR, { recursive: true });
let report = { generatedAt: new Date().toISOString(), checked: {}, summary: {} };
if (!fresh && existsSync(REPORT)) {
  try { report = JSON.parse(await readFile(REPORT, 'utf8')); } catch { /* начинаем заново */ }
}
report.checked = report.checked || {};

const queue = works.filter((w) => !report.checked[w.slug]).slice(0, limit || undefined);
console.log(`к сверке: ${queue.length} (уже проверено: ${Object.keys(report.checked).length} из ${works.length})`);

let done = 0;
for (const w of queue) {
  const ours = words(stripLeadMarks(w.text, w.title));
  let row;
  try {
    const orig = await fetchOriginal(w.sourceUrl);
    if (orig.error) {
      row = { title: w.title, status: 'error', error: orig.error, oursWords: ours.length };
    } else {
      // Латиница в оригинале — это остатки разметки (output, parser, linenum, n00),
      // в русском тексте Бунина её нет. Убираем, иначе выравнивание рвётся.
      const theirs = words(stripLeadMarks(orig.html, w.title)).filter((w) => !/^[a-z]+[0-9]*$/.test(w));
      const ratio = theirs.length ? +(ours.length / theirs.length).toFixed(3) : null;
      const a = align(ours, theirs);
      // Обрыв — это хвост оригинала после конца нашего текста. Низкое покрытие при
      // пустом хвосте означает иную редакцию или редакционные вставки, а не потерю конца.
      let status = 'ok';
      if (!a.found) status = 'не совпадает с оригиналом';
      else if (a.tailWords > 25) status = 'обрезано';
      else if (a.covered < 0.9) status = 'расхождения в тексте';
      row = { title: w.title, page: orig.title, status, ratio, covered: a.covered, tailWords: a.tailWords,
        tailSample: a.tailWords ? a.tailSample : '', oursWords: ours.length, origWords: theirs.length };
    }
  } catch (e) {
    row = { title: w.title, status: 'error', error: String(e.message || e), oursWords: ours.length };
  }
  report.checked[w.slug] = row;
  done += 1;
  if (done % 10 === 0 || done === queue.length) {
    await writeFile(REPORT, JSON.stringify(report, null, 1), 'utf8');
    const bad = Object.values(report.checked).filter((x) => x.status === 'обрезано').length;
    console.log(`  ${done}/${queue.length} · обрезано найдено: ${bad}`);
  }
  await sleep(DELAY_MS);
}

const rows = Object.values(report.checked);
const count = (s) => rows.filter((x) => x.status === s).length;
report.summary = {
  total: works.length,
  checked: rows.length,
  ok: count('ok'),
  'обрезано': count('обрезано'),
  'расхождения в тексте': count('расхождения в тексте'),
  'не совпадает с оригиналом': count('не совпадает с оригиналом'),
  error: count('error'),
  finishedAt: new Date().toISOString(),
};
await writeFile(REPORT, JSON.stringify(report, null, 1), 'utf8');

console.log('\n=== ИТОГ ===');
console.log(JSON.stringify(report.summary, null, 1));
const bad = rows.filter((x) => x.status !== 'ok' && x.status !== 'error')
  .sort((a, b) => (a.covered ?? 9) - (b.covered ?? 9));
if (bad.length) {
  console.log('\nТребуют просмотра:');
  for (const r of bad.slice(0, 60)) {
    console.log(`  ${String(r.status).padEnd(24)} покрытие ${String(r.covered).padEnd(6)} хвост ${String(r.tailWords).padEnd(4)} ${r.title} — ${r.oursWords} слов; за концом: ${r.tailSample}`);
  }
}
