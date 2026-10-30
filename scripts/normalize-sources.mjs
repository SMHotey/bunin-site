#!/usr/bin/env node
// Чистка поля source в data/works.json от вики-разметки.
//
// Импортёр тянет библиографическую ссылку как есть, и в данных оказываются
// шаблоны {{книга|автор = … |заглавие = …}}, внешние ссылки [http://… метка],
// неразрывные пробелы &nbsp; и жирный шрифт '''…'''. На странице это пока не
// видно, но это мусор: он всплывёт в поиске, в карточках и в JSON-LD.
//
// Приводим к читаемой строке: «И. А. Бунин. Полное собрание сочинений в 13
// томах. Т. 1. Стихотворения (1888—1911); Рассказы».
//
// Запуск: node scripts/normalize-sources.mjs [--dry]

import { readFile, writeFile } from 'node:fs/promises';

const DRY = process.argv.includes('--dry');
const path = 'data/works.json';
const works = JSON.parse(await readFile(path, 'utf8'));

const clean = (raw) => {
  let s = String(raw || '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  s = s.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, ' ').replace(/<[^>]+>/g, ' ');
  // {{книга|автор = X |заглавие = Y |год = 1973}} → «X. Y, 1973»
  s = s.replace(/\{\{([^{}]*)\}\}/g, (_, inner) => {
    const fields = {};
    for (const part of inner.split('|')) {
      const m = part.match(/^\s*([^\s=|]+)\s*=\s*([\s\S]*)$/);
      if (m) fields[m[1].toLowerCase()] = m[2].trim();
    }
    const bits = [fields['автор'], fields['заглавие'] || fields['название'], fields['год']]
      .filter(Boolean)
      .join('. ')
      .replace(/\.\s*\./g, '.');
    if (bits) return bits;
    // шаблон без полезных полей: оставляем только значения, а не имена параметров
    return inner.split('|').map((x) => x.split('=').slice(1).join('=').trim()).filter(Boolean).join(' ');
  });
  // [http://url метка] → «метка», [[статья|метка]] → «метка»
  s = s.replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, (_, url, label) => `${label} (${url})`);
  s = s.replace(/\[(https?:\/\/[^\s\]]+)\]/g, '$1');
  s = s.replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1').replace(/\[\[([^\]]+)\]\]/g, '$1');
  s = s.replace(/'''?/g, '');
  // остатки параметров шаблона: «| ДРУГОЕ =», висящие «|» и «=»
  s = s.replace(/\|\s*[^\s=|]*\s*=/g, ' ');
  s = s.replace(/^[\s|=]+/, '').replace(/[\s|=]+$/, '');
  s = s.replace(/\s*\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim();
  return s.replace(/[;,|=\s]+$/, '');
};

let changed = 0;
const samples = [];
for (const w of works) {
  if (!w.source) continue;
  const before = String(w.source);
  const after = clean(before);
  if (after !== before) {
    changed += 1;
    if (samples.length < 3) samples.push({ title: w.title, before: before.slice(0, 90), after: after.slice(0, 120) });
    if (!DRY) w.source = after;
  }
}

if (!DRY) {
  await writeFile(path, JSON.stringify(works, null, 1) + '\n', 'utf8');
}
console.log(`${DRY ? 'проверка' : 'очищено'}: ${changed} записей из ${works.length}`);
for (const s of samples) {
  console.log(`  ${s.title}\n    было:  ${s.before}\n    стало: ${s.after}`);
}
