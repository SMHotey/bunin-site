// Проверка ссылок в data/dossiers.json — по одной, с таймаутом и вежливой паузой.
// Отчёт: сколько ссылок, какие не открылись. Ничего не меняет.
import { readFile } from 'node:fs/promises';

const dossiers = JSON.parse(await readFile('data/dossiers.json', 'utf8'));
const urls = new Set();
for (const d of Object.values(dossiers)) {
  for (const f of d.facts || []) urls.add(f.source);
  for (const r of d.relations || []) urls.add(r.source);
  for (const s of d.sources || []) urls.add(s.url);
}
const list = [...urls].filter(Boolean);
console.log('ссылок:', list.length);

const bad = [];
let i = 0;
async function worker() {
  while (i < list.length) {
    const url = list[i++];
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; poet-bunin.ru link check)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
      if (res.status >= 400) bad.push(`${res.status} ${url}`);
      await res.body?.cancel();
    } catch (e) {
      bad.push(`ERR ${url} — ${e.name === 'TimeoutError' ? 'timeout' : e.message}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
console.log('битых:', bad.length);
for (const b of bad) console.log('  ', b);
