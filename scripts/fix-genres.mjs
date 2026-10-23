// Жанровая карта для data/works.json (и для build-works.mjs).
// Импорт Викитеки определял жанр по разделу страницы автора и путал прозу со стихами:
// 35 рассказов Бунина лежали в библиотеке как «Стихотворение», а стихотворение
// «Новый год» — как «Рассказ». Классифицируем по фактуре текста: у прозы средняя
// длина строки больше 12 слов, у стихов — меньше 8 (в корпусе разрыв чистый, 8—16 пусто).
// Запуск: node scripts/fix-genres.mjs [--write]
import { readFile, writeFile } from 'node:fs/promises';

const write = process.argv.includes('--write');
const works = JSON.parse(await readFile('data/works.json', 'utf8'));

const rows = works.map((w) => {
  const lines = (w.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const words = lines.map((l) => l.split(/\s+/).length);
  const avg = words.reduce((a, b) => a + b, 0) / (words.length || 1);
  return { title: w.title, genre: w.genre, avg, lines: lines.length };
});

const map = {};
const changes = [];
for (const r of rows) {
  const looksProse = r.avg > 12;
  const target = looksProse ? 'Рассказ' : 'Стихотворение';
  if (looksProse) map[r.title] = 'Рассказ';
  if (r.genre !== target) changes.push({ ...r, target });
}

const byGenre = {};
for (const r of rows) {
  const g = map[r.title] || 'Стихотворение';
  byGenre[g] = (byGenre[g] || 0) + 1;
}

console.log(`всего текстов: ${rows.length}`);
console.log('после классификации:', byGenre);
console.log(`исправлений: ${changes.length}`);
for (const c of changes) console.log(`  ${c.title} (${c.genre} → ${c.target}), средняя строка ${c.avg.toFixed(1)} слов`);

if (write) {
  await writeFile('data/genre-map.json', JSON.stringify(map, null, 1), 'utf8');
  console.log(`записано data/genre-map.json: ${Object.keys(map).length} прозаических текстов`);
} else {
  console.log('пробный прогон; для записи добавьте --write');
}
