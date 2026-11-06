// Проверка готовности dist/ к продакшену.
// Запуск: node scripts/verify.mjs [--strict]
// --strict превращает предупреждения в ошибки (для CI перед деплоем).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { moscowToday } from './today.mjs';

const DIST = 'dist';
const strict = process.argv.includes('--strict');
const errors = [];
const warnings = [];
const info = [];

const readJson = async (p) => {
  // Новый сайт начинается с пустых данных: отсутствие файла — это «пока нет»,
  // а не ошибка сборки. Иначе verify падает на первой же проверке книг.
  if (!existsSync(p)) return [];
  const raw = (await readFile(p, 'utf8')).trim();
  // Пустой файл данных — «пока нет», раздел показывает заглушку (см. build.mjs).
  return raw ? JSON.parse(raw) : [];
};
const config = await readJson('site.config.json');
const SITE = String(config.siteUrl || '').replace(/\/$/, '');

if (!SITE) errors.push('site.config.json: не задан siteUrl');
if (/\.example\b|example\.(org|com)/.test(SITE)) warnings.push('siteUrl всё ещё заглушка — укажите боевой домен');
if (config.affiliate?.enabled === false) info.push('партнёрские ссылки отключены в конфиге');

async function walk(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function distPathFor(urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p.endsWith('/')) p += 'index.html';
  return join(DIST, p.replace(/^\//, ''));
}

const files = await walk(DIST);
// Файлы подтверждения прав (yandex_<код>.html, google<код>.html и подобные) — служебные
// заглушки поисковиков: у них нет ни canonical, ни title, правила обычных страниц к ним не относятся.
const VERIFICATION_FILE = /(?:^|\/)(?:yandex|google|msvalidate|mailru)[_-]?[A-Za-z0-9]+\.html$/i;
const htmlFiles = files.filter((f) => extname(f) === '.html').filter((f) => !VERIFICATION_FILE.test(f.replace(/\\/g, '/')));
const titles = new Map();

// Фотографии персон: файл на месте, лицензия свободная, подпись и ссылка на файл есть.
// Фото без атрибуции — юридический и репутационный риск для просветительского сайта.
const peopleData = await readJson('data/people.json', []);
let photos = 0;
for (const person of peopleData) {
  if (!person.photo) continue;
  photos += 1;
  const rel = String(person.photo).replace(/^\//, '');
  if (!existsSync(join(DIST, rel))) errors.push(`фото персоны ${person.id}: нет файла ${person.photo}`);
  if (!/\.(jpe?g|png|webp)$/i.test(person.photo)) errors.push(`фото персоны ${person.id}: неожиданный формат ${person.photo}`);
  if (!person.photoAlt) errors.push(`фото персоны ${person.id}: нет alt`);
  if (!person.photoCredit) errors.push(`фото персоны ${person.id}: нет подписи об источнике`);
  if (!/pd|public domain|cc0/i.test(String(person.photoLicense || ''))) errors.push(`фото персоны ${person.id}: лицензия «${person.photoLicense || 'нет'}» — нужна свободная`);
  if (!person.photoSource) errors.push(`фото персоны ${person.id}: нет ссылки на страницу файла`);
}
if (photos) info.push(`фото персон: ${photos} из ${peopleData.length}`);

// Досье персон: каждое утверждение должно нести ссылку на источник.
// Досье без ссылок хуже, чем его отсутствие: оно выглядит как проверенный факт.
if (existsSync('data/dossiers.json')) {
  const dossiers = await readJson('data/dossiers.json');
  const people = existsSync('data/people.json') ? await readJson('data/people.json') : [];
  const ids = new Set((Array.isArray(people) ? people : []).map((x) => x.id));
  const isUrl = (u) => /^https?:\/\/[^\s]+\.[^\s]+/.test(String(u || ''));
  for (const [id, d] of Object.entries(dossiers || {})) {
    if (!ids.has(id)) errors.push(`досье: нет персоны с id «${id}»`);
    for (const [i, f] of (d.facts || []).entries()) {
      if (!String(f.claim || '').trim()) errors.push(`досье ${id}: факт ${i + 1} без текста`);
      if (!isUrl(f.source)) errors.push(`досье ${id}: факт ${i + 1} без ссылки на источник`);
    }
    for (const [i, r] of (d.relations || []).entries()) {
      if (!String(r.date || '').trim() || !String(r.event || '').trim()) errors.push(`досье ${id}: запись ${i + 1} без даты или события`);
      if (!isUrl(r.source)) errors.push(`досье ${id}: запись ${i + 1} без ссылки на источник`);
    }
    for (const s of d.sources || []) {
      if (!isUrl(s.url)) errors.push(`досье ${id}: источник «${s.label || '?'}» с битым адресом`);
    }
    if ((d.facts || []).length < 4) warnings.push(`досье ${id}: мало фактов (${(d.facts || []).length}) — возможно, недособрано`);
  }
  info.push(`досье: ${Object.keys(dossiers || {}).length} персон`);
}

for (const file of htmlFiles) {
  const rel = file.replace(/\\/g, '/').replace(/^dist\//, '');
  const html = await readFile(file, 'utf8');

  if (!html.startsWith('<!doctype html>')) errors.push(`${rel}: нет doctype`);
  if (!/<html lang="[a-z-]+"/.test(html)) errors.push(`${rel}: нет lang у <html>`);
  if (html.includes('__CANONICAL__')) errors.push(`${rel}: не подставлен canonical`);

  const title = html.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
  if (!title.trim()) errors.push(`${rel}: пустой <title>`);
  else if (title.length > 90) warnings.push(`${rel}: длинный title (${title.length})`);
  if (title) {
    if (titles.has(title)) errors.push(`${rel}: дублируется title с ${titles.get(title)}`);
    else titles.set(title, rel);
  }

  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1] || '';
  if (!desc) errors.push(`${rel}: нет description`);
  else if (desc.length < 50) warnings.push(`${rel}: короткий description (${desc.length})`);

  const h1 = (html.match(/<h1[\s>]/g) || []).length;
  if (h1 !== 1) errors.push(`${rel}: h1 встречается ${h1} раз`);

  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || '';
  if (!canonical) errors.push(`${rel}: нет canonical`);
  else if (!canonical.startsWith(SITE + '/')) errors.push(`${rel}: canonical вне siteUrl`);

  const robots = html.match(/<meta name="robots" content="([^"]+)"/)?.[1] || '';
  if (rel === '404.html' && !robots.includes('noindex')) errors.push('404.html: должен быть noindex');

  const ogImage = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || '';
  if (ogImage) {
    const local = ogImage.replace(SITE, '');
    if (!existsSync(join(DIST, decodeURIComponent(local)))) errors.push(`${rel}: og:image не найден (${local})`);
  }

  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (!ld.length) warnings.push(`${rel}: нет JSON-LD`);
  for (const [, body] of ld) {
    try { JSON.parse(body); } catch (e) { errors.push(`${rel}: битый JSON-LD (${e.message})`); }
  }

  // Экранированный HTML-тег в отрендеренной странице = сырой тег в markdown или данных:
  // генератор прогоняет текст через esc(), и читатель видит «<a href=…>» обычным текстом.
  const escTag = html.match(/&lt;\/?[a-zA-Z][a-zA-Z0-9]*(?:[^&]|&(?!gt;))*?(?:&gt;|&nbsp;|\s|$)/);
  if (escTag) errors.push(`${rel}: на странице виден экранированный HTML «${escTag[0].slice(0, 60)}» — в источнике сырой тег`);

  // внутренние ссылки
  for (const [, href] of html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
    if (href.startsWith('//')) continue;
    const target = distPathFor(href);
    if (!existsSync(target)) errors.push(`${rel}: битая ссылка ${href}`);
    else if ((await stat(target)).isDirectory() && !existsSync(join(target, 'index.html'))) {
      errors.push(`${rel}: каталог без index.html ${href}`);
    }
  }
}

// --- sitemap ---
const sitemap = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (!locs.length) errors.push('sitemap.xml пуст');
for (const loc of locs) {
  if (!loc.startsWith(SITE)) errors.push(`sitemap: чужой домен ${loc}`);
  const path = decodeURIComponent(new URL(loc).pathname);
  if (!existsSync(distPathFor(path))) errors.push(`sitemap: нет файла для ${path}`);
}
if (locs.some((l) => l.includes('/404.html'))) errors.push('sitemap: 404 не должен индексироваться');
if (!locs.some((l) => l.endsWith('/books/'))) errors.push('sitemap: нет раздела книг');
if (locs.length > htmlFiles.length) errors.push('sitemap: URL больше, чем HTML-страниц');
if (!sitemap.includes('image:image')) warnings.push('sitemap: нет картинок (портрет и обложки)');

// --- RSS-лента ---
const feedPath = join(DIST, 'feed.xml');
if (!existsSync(feedPath)) errors.push('нет feed.xml');
else {
  const feed = await readFile(feedPath, 'utf8');
  const items = [...feed.matchAll(/<item>/g)].length;
  if (!items) errors.push('feed.xml: нет ни одного item');
  if (!feed.includes(`${SITE}/feed.xml`)) errors.push('feed.xml: нет atom:link на себя');
  if (!feed.includes(SITE)) errors.push('feed.xml: ссылки не на боевой домен');
}

// --- журнал (публикации) и статьи биографии ---
// Картинка — одна на сайт: и в журнале, и в статьях биографии каждая илл. уникальна.
const editorialImages = new Map();
const checkEditorialImage = (label, f, fm, section) => {
  const image = fm('image');
  if (!image) return false;
  if (!existsSync(join(DIST, image.replace(/^\//, '')))) errors.push(`${label}: нет файла картинки ${image}`);
  if (!fm('imageAlt')) errors.push(`${label}: у картинки нет imageAlt`);
  if (!/pd|public domain|cc0|cc by/i.test(fm('imageLicense'))) errors.push(`${label}: лицензия «${fm('imageLicense') || 'нет'}» — нужна свободная`);
  if (!String(fm('imageSource')).startsWith('https://commons.wikimedia.org/')) errors.push(`${label}: нет ссылки на файл Викисклада (imageSource)`);
  const seen = editorialImages.get(image);
  if (seen) errors.push(`${label}: картинка ${image} уже стоит в ${seen} — повторы в журнале и статьях не нужны`);
  else editorialImages.set(image, `${section} ${f}`);
  return true;
};
const pubDir = join('content', 'publications');
if (existsSync(pubDir)) {
  const today = moscowToday();
  const files = (await readdir(pubDir)).filter((f) => f.endsWith('.md'));
  let published = 0;
  for (const f of files) {
    const raw = await readFile(join(pubDir, f), 'utf-8');
    const title = raw.match(/^title:\s*"?([^"\n]+)"?\s*$/m)?.[1]?.trim();
    const slug = raw.match(/^slug:\s*(\S+)\s*$/m)?.[1]?.trim() || f.replace(/\.md$/, '');
    const date = raw.match(/^date:\s*(\S+)\s*$/m)?.[1]?.trim();
    if (!title) errors.push(`публикация ${f}: нет title`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) errors.push(`публикация ${f}: нет даты YYYY-MM-DD`);
    // Сырой HTML в markdown: генератор экранирует теги (esc в inline), и читатель
    // увидит их на странице текстом — «<a href=…>Библиотека</a>». Ссылка = [текст](/путь/).
    const pubBody = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
    if (/<\/?[a-zA-Z][^>]*>/.test(pubBody)) {
      errors.push(`публикация ${f}: в тексте сырой HTML — ссылки пишутся как [текст](/путь/), теги не нужны`);
    }
    // Разработчицкие детали (пути скриптов, npm-команды, JSON-файлы данных) в тексте
    // для читателя — признак недописанной редакционной правки.
    if (/\b(?:scripts\/[\w./-]+|npm run [\w:.-]+|reports\/[\w./-]+|data\/[\w-]+\.json|[\w-]+\.mjs)\b/.test(raw)) {
      errors.push(`публикация ${f}: разработчицкие пути/команды (scripts/, npm run, reports/, data/) в тексте для читателя`);
    }
    // Иллюстрация публикации: карточки журнала стоят рядом, поэтому картинки должны
    // быть разными, а у картинки — полная атрибуция. Пока картинки нет — это
    // предупреждение: журнал должен получить свою иллюстрацию к каждой публикации.
    const fm = (name) => raw.match(new RegExp(`^${name}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'))?.[1]?.trim() || '';
    if (!checkEditorialImage(`публикация ${f}`, f, fm, 'публикация')) {
      warnings.push(`публикация ${f}: нет иллюстрации (image) — у карточки журнала нет картинки`);
    }
    const page = join(DIST, 'publications', `${slug}.html`);
    const isFuture = /^\d{4}-\d{2}-\d{2}$/.test(date || '') && date > today;
    if (!isFuture) {
      published += 1;
      if (!existsSync(page)) errors.push(`публикация ${f}: не выпущена, но страницы ${slug}.html нет`);
    } else if (existsSync(page) && process.env.PUBLISH_ALL !== '1') {
      errors.push(`публикация ${f}: будущая дата ${date}, а страница уже в dist`);
    }
  }
  // Правило редакции: одна публикация в день, и в запасе всегда готовые статьи
  // на две недели. Это не ошибка деплоя (иначе срочная правка не выйдет на сайт),
  // но каждый прогон напоминает, что запас кончается.
  const futureDates = [];
  for (const f of files) {
    const raw = await readFile(join(pubDir, f), 'utf-8');
    const d = raw.match(/^date:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1];
    if (d && d > today) futureDates.push(d);
  }
  futureDates.sort();
  if (futureDates.length) {
    const isWeekday = (iso) => {
      const day = new Date(iso + 'T12:00:00Z').getUTCDay();
      return day !== 0 && day !== 6;
    };
    const last = futureDates[futureDates.length - 1];
    let buffer = 0;
    const cursor = new Date(today + 'T12:00:00Z');
    while (cursor.toISOString().slice(0, 10) < last) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (isWeekday(cursor.toISOString().slice(0, 10))) buffer += 1;
    }
    buffer += 1;
    if (buffer < 14) warnings.push(`очередь журнала: готовых статей на ${buffer} будних дней вперёд из 14 — пора писать`);
    else info.push(`очередь журнала: запас ${buffer} будних дней`);
  } else {
    warnings.push('очередь журнала пуста: нет ни одной статьи с будущей датой — публиковать будет нечего');
  }
  if (!existsSync(join(DIST, 'publications', 'index.html'))) errors.push('нет index.html журнала');
  if (!sitemap.includes('/publications/')) errors.push('карта сайта: нет журнала');
}

// --- статьи биографии (content/*.md) ---
// У статьи о жизни — та же илл. и та же атрибуция, что у публикации: раздел читают
// подряд, и повтор картинки из журнала здесь сразу заметен.
{
  const contentDir = join('content');
  const files = (await readdir(contentDir)).filter((f) => f.endsWith('.md'));
  let withPhoto = 0;
  for (const f of files) {
    const raw = await readFile(join(contentDir, f), 'utf-8');
    const fm = (name) => raw.match(new RegExp(`^${name}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'))?.[1]?.trim() || '';
    if (!fm('title')) errors.push(`статья ${f}: нет title`);
    if (!fm('slug')) errors.push(`статья ${f}: нет slug`);
    if (checkEditorialImage(`статья ${f}`, f, fm, 'статья')) withPhoto += 1;
    else warnings.push(`статья ${f}: нет иллюстрации (image) — у статьи биографии нет картинки`);
  }
  if (withPhoto) info.push(`статьи биографии с картинкой: ${withPhoto} из ${files.length}`);
}

// --- поиск ---
const search = await readJson(join(DIST, 'search.json'));
if (!Array.isArray(search) || !search.length) errors.push('search.json пуст');
for (const item of search.slice(0, 500)) {
  if (!item.u || !existsSync(distPathFor(item.u))) errors.push(`search.json: битый URL ${item.u}`);
}

// --- книги ---
const books = await readJson('data/books.json');
if (!books.length) warnings.push('data/books.json пуст — раздел «Книги» покажет заглушку');
for (const b of books) {
  if (!b.title || !b.annotation) errors.push(`books.json: у ${b.id || '?'} нет title/annotation`);
  for (const l of b.links || []) {
    if (!/^https:\/\//.test(l.url)) errors.push(`books.json: ${b.id} — ссылка не https`);
  }
}
const markedLinks = books.some((b) => (b.links || []).some((l) => /[?&](erid|partnerid)=/i.test(l.url || '')));
if (config.affiliate?.enabled && books.length && !Object.values(config.affiliate?.stores || {}).some((s) => s.tag) && !markedLinks) {
  warnings.push('партнёрские ссылки без меток: заполните affiliate.stores.*.tag');
}
const booksHtml = await readFile(join(DIST, 'books/index.html'), 'utf8');
if (books.length && !booksHtml.includes('rel="sponsored')) errors.push('books: у ссылок нет rel="sponsored"');
// Маркировка рекламы обязана быть в заданной форме: «Реклама. Рекламодатель … , ОГРН …»
// Обязательна только если на странице есть партнёрские (рекламные) ссылки:
// без ссылок маркировать нечего — раздел показывает обычные карточки изданий.
const adv = config.affiliate?.advertiser || {};
const hasAdLinks = booksHtml.includes('erid:');
if (books.length && adv.name && hasAdLinks) {
  const required = `Реклама. Рекламодатель ${adv.name}${adv.ogrn ? `, ОГРН ${adv.ogrn}` : ''}.`;
  if (!booksHtml.includes(required)) errors.push(`books: нет обязательной маркировки «${required}»`);
}
// Цена: собирается всегда, публикуется только при affiliate.showPrice.
// Проверяем структурно, а не поиском числа (число может случайно встретиться в ISBN или страницах).
const showPrice = config.affiliate?.showPrice === true;
const hasPriceBlock = booksHtml.includes('class="book-price"') || booksHtml.includes('bp-value');
if (books.length && showPrice && !hasPriceBlock) errors.push('books: affiliate.showPrice включён, но цены на странице нет');
if (books.length && !showPrice && hasPriceBlock) errors.push('books: цена попала на страницу при выключенном affiliate.showPrice');
for (const b of books) {
  if (b.price && !b.priceCheckedAt) warnings.push(`books: ${b.id} — у цены нет даты проверки (priceCheckedAt)`);
}
// Обложки книг должны попадать в сборку
for (const b of books) {
  for (const key of ['cover', 'coverWebp']) {
    if (!b[key]) continue;
    const f = join(DIST, b[key].replace(/^\//, ''));
    if (!existsSync(f)) errors.push(`books: ${b.id} — файл обложки ${b[key]} не попал в dist/`);
    else if ((await stat(f)).size < 1024) errors.push(`books: ${b.id} — обложка ${b[key]} подозрительно мала`);
  }
}
// Проверяем маркировку интернет-рекламы: если в ссылке есть erid, он должен быть виден на странице.
for (const b of books) {
  for (const l of b.links || []) {
    const erid = (String(l.url).match(/[?&]erid=([^&]+)/i) || [])[1];
    if (erid && !booksHtml.includes(`erid: ${decodeURIComponent(erid)}`)) {
      errors.push(`books: у ${b.id} ссылка с erid=${decodeURIComponent(erid)}, но erid не выведен на странице`);
    }
  }
}


// --- аудиокниги (ЛитРес, партнёрская программа AdvCake) ---
const audiobooks = await readJson('data/audiobooks.json');
if (!audiobooks.length) warnings.push('data/audiobooks.json пуст — раздел «Аудиокниги» покажет заглушку');
const audioHtml = await readFile(join(DIST, 'audiobooks/index.html'), 'utf8');
if (audiobooks.length && !locs.some((l) => l.endsWith('/audiobooks/'))) errors.push('sitemap: нет раздела аудиокниг');
for (const b of audiobooks) {
  if (!b.title || !b.annotation) errors.push(`audiobooks.json: у ${b.id || '?'} нет title/annotation`);
  if (!b.durationMinutes) errors.push(`audiobooks.json: у ${b.id || '?'} нет длительности`);
  if (!(b.readers || []).length) errors.push(`audiobooks.json: у ${b.id || '?'} нет чтеца`);
  for (const l of b.links || []) {
    if (!/^https:\/\//.test(l.url || '')) errors.push(`audiobooks.json: ${b.id} — ссылка не https`);
    if (l.store !== 'litres') errors.push(`audiobooks.json: ${b.id} — неожиданный магазин ${l.store}`);
  }
}
// Один товар — одна карточка: дубли по productId ломают и вёрстку, и аналитику.
const audioIds = new Set();
for (const b of audiobooks) {
  if (audioIds.has(b.productId)) errors.push(`audiobooks.json: товар ${b.productId} встречается дважды`);
  audioIds.add(b.productId);
}
if (audiobooks.length) {
  const cardsInHtml = (audioHtml.match(/class="book-card"/g) || []).length;
  if (cardsInHtml !== audiobooks.length) errors.push(`аудиокниги: на странице ${cardsInHtml} карточек, в данных ${audiobooks.length}`);
  if (!audioHtml.includes('rel="sponsored')) errors.push('аудиокниги: у ссылок нет rel="sponsored"');
  const litresAdv = config.affiliate?.stores?.litres?.advertiser || {};
  const hasAudioAdLinks = audioHtml.includes('erid:');
  if (hasAudioAdLinks) {
    if (!litresAdv.name) errors.push('аудиокниги: у магазина litres не задан advertiser для маркировки');
    else {
      const required = `Реклама. Рекламодатель ${litresAdv.name}${litresAdv.ogrn ? `, ОГРН ${litresAdv.ogrn}` : ''}${litresAdv.inn ? `, ИНН ${litresAdv.inn}` : ''}.`;
      if (!audioHtml.includes(required)) errors.push(`аудиокниги: нет обязательной маркировки «${required}»`);
    }
  }
  // Цены аудиокниг не публикуются и не собираются: в данных их просто нет.
  if (audioHtml.includes('class="book-price"') || audioHtml.includes('bp-value')) errors.push('аудиокниги: на странице появилась цена');
  for (const b of audiobooks) {
    for (const key of ['cover', 'coverWebp']) {
      if (!b[key]) continue;
      const f = join(DIST, b[key].replace(/^\//, ''));
      if (!existsSync(f)) errors.push(`аудиокниги: ${b.id} — файл обложки ${b[key]} не попал в dist/`);
      else if ((await stat(f)).size < 1024) errors.push(`аудиокниги: ${b.id} — обложка ${b[key]} подозрительно мала`);
    }
    for (const l of b.links || []) {
      const erid = (String(l.url).match(/[?&]erid=([^&]+)/i) || [])[1];
      if (!erid) errors.push(`аудиокниги: ${b.id} — в партнёрской ссылке нет erid`);
      else if (!audioHtml.includes(`erid: ${decodeURIComponent(erid)}`)) errors.push(`аудиокниги: у ${b.id} erid не выведен на странице`);
    }
  }
}

// --- тексты произведений ---
// Импорт с Викитеки оставлял <ref> в параметрах шаблонов, «== 1 ==» и __NOTOC__ —
// на странице это мусор. Гейт, чтобы чистка не откатилась при следующем импорте.
const worksData = await readJson('data/works.json');
for (const w of worksData) {
  const t = String(w.text || '');
  if (/<\/?[a-zA-Z][^>]*>/.test(t)) errors.push(`works.json: ${w.slug} — сырые HTML-теги в тексте произведения`);
  if (/(?:^|\n)__\w+__/.test(t)) errors.push(`works.json: ${w.slug} — wiki-хелперы (__NOTOC__) в тексте`);
  if (/(?:^|\n)==+[^=\n]+==+\s*(?:\n|$)/.test(t)) errors.push(`works.json: ${w.slug} — wiki-заголовки «== … ==» в тексте`);
  // Заглушка вместо текста: на Викитеке часть страниц — библиографический список
  // («* «Строка…» //»), а не само произведение. Такой текст нельзя показывать.
  // Двухстрочные миниатюры Бунина — это 80–90 знаков, поэтому порог низкий; заглушки
  // ловятся не длиной, а признаками библиографической строки ниже.
  if (t.length < 60) errors.push(`works.json: ${w.slug} — текст короче 60 знаков (${t.length}), похоже на заглушку`);
  if (/^\s*\*/.test(t) || /\s\/\/\s*$/.test(t)) errors.push(`works.json: ${w.slug} — библиографическая строка вместо произведения`);
  if (/^\s*mode\s*=|^\s*\|\s*[А-ЯЁ_]{4,}\s*=/.test(t)) errors.push(`works.json: ${w.slug} — в начале текста остались параметры вики-шаблона`);
  // Поле «первая публикация» показывается в карточке произведения: wiki-разметка
  // и обрывки шаблонов там видны читателю как мусор.
  if (/[=<>]|\{\{|\}\}|&nbsp;/.test(String(w.published || ''))) {
    errors.push(`works.json: ${w.slug} — разметка в поле published: «${String(w.published).slice(0, 60)}»`);
  }
}
// Годы жизни автора из конфига: «1870—1953». Год произведения за пределами этих
// рамок — почти всегда год издания, случайно попавший в поле `year` при импорте.
const lifeYears = String(config.author?.years || '').match(/(\d{4})\D+(\d{4})/);
const bornYear = lifeYears ? Number(lifeYears[1]) : null;
const diedYear = lifeYears ? Number(lifeYears[2]) : null;
let noSource = 0;
for (const w of worksData) {
  const year = Number(w.year);
  if (bornYear && diedYear && year) {
    if (year > diedYear) errors.push(`works.json: ${w.slug} — год ${year} позже смерти автора (${diedYear}): в поле year должен быть год написания`);
    if (year < bornYear) errors.push(`works.json: ${w.slug} — год ${year} раньше рождения автора (${bornYear})`);
  }
  if (!String(w.source || '').trim()) noSource += 1;
}
if (noSource) warnings.push(`works.json: у ${noSource} произведений не указано издание-источник (поле source)`);
if (worksData.length) info.push(`произведений проверено: ${worksData.length}`);

// --- книжный вид: разметка прозы (перенос из esenin-dashboard) ---
// V1. Охват задан конфигом, а не кодом: без genres/minChars книгу не собрать.
const bookCfg = config.reader?.book || {};
if (bookCfg.available !== true) {
  errors.push('site.config.json: reader.book.available не включён — книжного режима нет');
}
if (!Array.isArray(bookCfg.genres) || !bookCfg.genres.length || !(Number(bookCfg.minChars) > 0)) {
  errors.push('site.config.json: нет reader.book.genres/minChars');
}
// V2. Отбор по конфигу: 36 рассказов (замер на данных 06.11.2026). Число
// зафиксировано как база: смена жанра или chars — решение владельца, а не
// побочный эффект импорта, поэтому расхождение — ошибка, а не предупреждение.
const bookGenres = new Set(bookCfg.genres || []);
const bookMin = Number(bookCfg.minChars) || 1500;
const BOOK_EXPECT = 36;
const bookSelection = worksData.filter((w) => bookGenres.has(w.genre) && (w.chars || 0) >= bookMin);
if (bookSelection.length !== BOOK_EXPECT) {
  errors.push(`book: по reader.book отобрано ${bookSelection.length} текстов вместо ${BOOK_EXPECT}`);
}
const bookSelSlugs = new Set(bookSelection.map((w) => w.slug));
const collapseBook = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const decodeBook = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&');

// V4. Содержимое обёртки .poem[data-book-source] без потери знаков.
// Идём по тегам и считаем баланс div — иначе оборвёмся на вложенном book-verse.
function bookInner(html) {
  const at = html.indexOf('class="poem" data-book-source');
  if (at < 0) return null;
  const openEnd = html.indexOf('>', at);
  if (openEnd < 0) return null;
  let depth = 1;
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = openEnd + 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(openEnd + 1, m.index);
    } else {
      depth += 1;
    }
  }
  return null;
}
const bookPlain = (inner) => collapseBook(decodeBook(String(inner)
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')));

// V3. Обёртка стоит ровно у отобранных текстов и отсутствует у остальных.
const bookPages = new Map();
let bookBlocks = 0;
for (const w of worksData) {
  const rel = `works/${w.slug}.html`;
  const file = join(DIST, rel);
  if (!existsSync(file)) continue; // пропажу поймает проверка ссылок
  const html = await readFile(file, 'utf8');
  const inner = bookInner(html);
  if (inner == null) {
    if (bookSelSlugs.has(w.slug)) errors.push(`${rel}: у текста книги нет обёртки .poem[data-book-source]`);
    continue;
  }
  if (!bookSelSlugs.has(w.slug)) {
    errors.push(`${rel}: обёртка data-book-source у текста вне отбора reader.book`);
    continue;
  }
  bookPages.set(w.slug, html);
  bookBlocks += (inner.match(/<p[\s>]/g) || []).length
    + (inner.match(/class="book-verse"/g) || []).length
    + (inner.match(/class="book-head"/g) || []).length;
  const got = bookPlain(inner);
  const want = collapseBook(w.text);
  if (got !== want) {
    let i = 0;
    while (i < got.length && got[i] === want[i]) i += 1;
    errors.push(`${rel}: текст книги расходится с works.json на позиции ${i}: «${got.slice(i, i + 40)}» вместо «${want.slice(i, i + 40)}»`);
  }
  // chars — длина текста по-сырому; строковое равенство выше держит собранные
  // знаки, здесь — связка «chars = длине text».
  if (w.chars !== w.text.length) {
    errors.push(`${rel}: chars ${w.chars} при длине text ${w.text.length} в works.json`);
  }
}
if (bookPages.size !== BOOK_EXPECT) errors.push(`book: страниц с обёрткой data-book-source ${bookPages.size} вместо ${BOOK_EXPECT}`);
info.push(`book: ${bookPages.size} текстов, ${bookBlocks} абзацев`);

// V3б. Структурные строки размечены, а не остались абзацами. Замеры на данных
// 06.11.2026: «Антоновские яблоки» — I–IV и подзаголовок, «Тёмные аллеи» — I,
// «Лёгкое дыхание» — год. Расхождение означает, что правило разбора изменилось.
const bookTypeExpect = {
  'антоновские-яблоки': { 'book-part': 4, 'book-head': 1 },
  'темные-аллеи': { 'book-part': 1 },
  'легкое-дыхание': { 'book-date': 1 },
};
for (const [slug, expect] of Object.entries(bookTypeExpect)) {
  const html = bookPages.get(slug);
  if (!html) {
    errors.push(`book: нет страницы works/${slug}.html с обёрткой data-book-source`);
    continue;
  }
  for (const [cls, want] of Object.entries(expect)) {
    const got = (html.match(new RegExp(`class="${cls}"`, 'g')) || []).length;
    if (got !== want) errors.push(`works/${slug}.html: блоков ${cls} ${got}, ожидалось ${want}`);
  }
}
if (bookPages.has('антоновские-яблоки') && /<p>\s*(?:I|II|III|IV)\s*<\/p>/.test(bookPages.get('антоновские-яблоки'))) {
  errors.push('works/антоновские-яблоки.html: номер части остался абзацем p');
}
if (bookPages.has('легкое-дыхание') && /<p>\s*19\d\d\s*<\/p>/.test(bookPages.get('легкое-дыхание'))) {
  errors.push('works/легкое-дыхание.html: год остался абзацем p');
}

// V5. Книга грузится по клику: файлы книги на месте, вендоренный лист цел и в
// бюджете, canvas в разметке нет, статического <script src="book.js"> нет.
for (const f of ['book.js', 'book.css', 'stpageflip.js']) {
  if (!existsSync(join(DIST, 'book', f))) errors.push(`dist/book/${f} отсутствует`);
}
const flipPath = join(DIST, 'book', 'stpageflip.js');
if (existsSync(flipPath)) {
  const raw = await readFile(flipPath);
  // Заголовка MIT в самом бандле нет (он добавлен при вендоринге), поэтому
  // проверяется начало файла.
  const head = raw.subarray(0, 2048).toString('utf8');
  if (!head.includes('MIT') || !head.includes('StPageFlip')) {
    errors.push('dist/book/stpageflip.js: в первых 2 КБ нет заголовка MIT со StPageFlip');
  }
  if (raw.length > 51200) errors.push(`dist/book/stpageflip.js: ${raw.length} байт при бюджете 51200`);
  else info.push(`book: StPageFlip ${raw.length} байт`);
}
// Суммарный бюджет книжного кода (порог серии — 64 КБ).
const BOOK_BUDGET = 65536;
let bookCodeBytes = 0;
let bookCodeComplete = true;
for (const f of ['book.js', 'book.css']) {
  const p = join(DIST, 'book', f);
  if (!existsSync(p)) { bookCodeComplete = false; continue; }
  bookCodeBytes += (await stat(p)).size;
}
if (bookCodeComplete && bookCodeBytes > BOOK_BUDGET) {
  errors.push(`dist/book: book.js + book.css ${bookCodeBytes} байт при бюджете ${BOOK_BUDGET}`);
}
// Счётчик Метрики продублирован в src/book/book.js (модулю конфиг недоступен):
// у серии сайтов счётчики разные, поэтому расхождение — ошибка.
const ymId = String(config.analytics?.yandexMetrika || '');
if (ymId) {
  const bookJs = existsSync(join(DIST, 'book', 'book.js'))
    ? await readFile(join(DIST, 'book', 'book.js'), 'utf8') : '';
  const inBook = /const YM_ID = '(\d+)'/.exec(bookJs);
  if (!inBook) errors.push('dist/book/book.js: не найдена константа YM_ID');
  else if (inBook[1] !== ymId) errors.push(`dist/book/book.js: YM_ID ${inBook[1]} не совпадает с analytics.yandexMetrika ${ymId}`);
  else info.push('book: счётчик Метрики совпадает с конфигом');
}

// Кнопка «Режим книги» — ровно у отобранных текстов и ни у кого из коротких
// проза-жанров (chars < reader.book.minChars).
const bookShortSlugs = new Set(
  worksData.filter((w) => bookGenres.has(w.genre) && (w.chars || 0) < bookMin).map((w) => w.slug),
);
let bookBtnPages = 0;
for (const w of worksData) {
  const rel = `works/${w.slug}.html`;
  const file = join(DIST, rel);
  if (!existsSync(file)) continue;
  const html = await readFile(file, 'utf8');
  const hasBtn = html.includes('data-poem-action="book"');
  if (hasBtn) bookBtnPages += 1;
  if (bookSelSlugs.has(w.slug) && !hasBtn) errors.push(`${rel}: у текста книги нет кнопки «Режим книги»`);
  if (bookShortSlugs.has(w.slug) && hasBtn) errors.push(`${rel}: кнопка «Режим книги» у короткого текста (chars ${w.chars} < ${bookMin})`);
}
if (bookBtnPages !== BOOK_EXPECT) errors.push(`book: страниц с кнопкой «Режим книги» ${bookBtnPages} вместо ${BOOK_EXPECT}`);

// V6. Текст книги обязан оставаться текстом, а скрипт — грузиться по клику.
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const rel = file.replace(/\\/g, '/');
  if (/<canvas[\s>]/i.test(html)) errors.push(`${rel}: элемент canvas в разметке`);
  if (/<script[^>]+src="[^"]*book\.js/.test(html)) {
    errors.push(`${rel}: book.js подключён статическим script src в HTML`);
  }
}

// --- служебные файлы ---

// Служебные оговорки сборщика не должны доходить до читателя: на странице —
// готовый текст, а не разговор сайта с самим собой. Ловим формулировки,
// которые уже попадали в публикацию («в этом пакете», «выдуманный список»);
// одиночное «выдуманный» не ловим — оно встречается у Бунина в прозе.
const META_PHRASES = [
  'в этом пакете',
  'в данном пакете',
  'перед публикацией его нужно сверить',
  'выдуманный длинный список',
  'каждая строка подтверждается',
  'сокращён сознательно',
];
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const lowered = html.toLowerCase();
  for (const phrase of META_PHRASES) {
    if (lowered.includes(phrase)) errors.push(`${file}: служебная оговорка «${phrase}» видна читателю`);
  }
}
// Печать: на бумагу идёт только произведение. «Похожие произведения», переходы
// к соседним текстам и блок источника помечены классами и выключены в @media
// print — проверяем, что разметка и правило не разошлись между собой.
const printCss = await readFile(join(DIST, 'styles.css'), 'utf8');
const printBlocks = [...printCss.matchAll(/@media print \{[\s\S]*?\n\}/g)].map((m) => m[0]);
if (!printBlocks.some((b) => b.includes('.related-works') && b.includes('.work-nav') && b.includes('.source-box'))) {
  errors.push('styles.css: в @media print не выключены «Похожие произведения», переходы или источник');
}
const sampleWork = worksData.find((w) => existsSync(join(DIST, 'works', `${w.slug}.html`)));
if (sampleWork) {
  const sampleHtml = await readFile(join(DIST, 'works', `${sampleWork.slug}.html`), 'utf8');
  if (!sampleHtml.includes('class="section related-works"')) errors.push(`works/${sampleWork.slug}.html: «Похожие произведения» без класса related-works — блок попадёт на печать`);
  if (!sampleHtml.includes('class="work-nav"')) errors.push(`works/${sampleWork.slug}.html: переходы к соседним текстам без класса work-nav`);
}

for (const f of ['404.html', 'robots.txt', 'sitemap.xml', 'search.json', '_headers', '_redirects', '.nojekyll', 'favicon.svg', 'styles.css', 'app.js']) {
  if (!existsSync(join(DIST, f))) errors.push(`dist/${f} отсутствует`);
}
if (!existsSync(join(DIST, 'books/index.html'))) errors.push('нет страницы /books/');
if (!existsSync(join(DIST, 'theme.js'))) errors.push('нет /theme.js (анти-вспышка темы)');

// --- редакционный тон страниц ---
// Формулы, которые выдают текст, собранный роботом: обращение к учителю,
// обещания «вы узнаете», канцелярские концовки. Проверяем весь dist, а не
// только журнал: эти фразы умеют просачиваться в описания разделов.
const BAD_TONE = [
  'как использовать на уроке',
  'что использовать на уроке',
  'что важно знать к разбору',
  'по одной публикации в день',
  'факты сверены с академическими изданиями',
  'формулировки — наши',
  'в этой статье мы расскажем',
  'вы узнаете',
];
for (const f of htmlFiles) {
  const text = await readFile(f, 'utf8');
  const low = text.toLowerCase();
  for (const phrase of BAD_TONE) {
    if (low.includes(phrase)) errors.push(`${f}: редакционная формула «${phrase}» — переписать живым текстом`);
  }
}

// --- «Обновлено»: фактическая дата правки ---
// Одна дата на всех страницах означает, что lastmod и подвал считаются от
// сборки, а не от правки материала. Манифест обязан быть, даты — различаться.
if (!existsSync('data/updated.json')) errors.push('data/updated.json: нет манифеста дат разделов — запустить npm run stamp:updated');
else {
  const manifest = JSON.parse(await readFile('data/updated.json', 'utf8'));
  const sections = manifest.sections || {};
  if (!Object.keys(sections).length) errors.push('data/updated.json: пустой манифест разделов');
  const sitemapXml = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
  const dates = new Set([...sitemapXml.matchAll(/<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)].map((m) => m[1]));
  if (dates.size === 1 && htmlFiles.length > 50) {
    errors.push(`sitemap: lastmod одинаковый у всех страниц (${[...dates][0]}) — дата берётся от сборки, а не от правки`);
  } else {
    info.push(`lastmod: ${dates.size} различных дат`);
  }
}

// --- вики-разметка в источниках произведений ---
// Импортёр тянул библиографическую ссылку как есть: {{книга|…}}, [http://… метка],
// &nbsp;, '''…'''. На странице это не видно, но в данных это мусор.
try {
  const worksData = JSON.parse(await readFile('data/works.json', 'utf8'));
  const dirty = worksData.filter((x) => /\{\{|\}\}|\[https?:|&nbsp;|'''|<ref/.test(String(x.source || '')));
  if (dirty.length) {
    errors.push(`data/works.json: вики-разметка в source у ${dirty.length} записей (например, «${dirty[0].title}») — запустить npm run clean:sources`);
  } else {
    info.push('источники произведений без вики-разметки');
  }
} catch {
  warnings.push('data/works.json: не удалось проверить поле source');
}

// --- служебные файлы поисковиков: ключ IndexNow и файлы подтверждения ---
const indexNowKey = String(config.indexNow?.key || '').trim();
if (config.indexNow?.enabled !== false && indexNowKey) {
  const keyPath = join(DIST, `${indexNowKey}.txt`);
  if (!existsSync(keyPath)) errors.push(`нет файла ключа IndexNow dist/${indexNowKey}.txt`);
  else info.push('IndexNow: ключ на месте');
}
for (const [kind, prefix, content] of [['yandex', 'yandex_', 'Verification: '], ['google', 'google', 'google-site-verification: ']]) {
  const code = String(config.verification?.[kind] || '').trim();
  if (!code) continue;
  const file = join(DIST, `${prefix}${code}.html`);
  if (!existsSync(file)) errors.push(`нет файла подтверждения ${kind}: dist/${prefix}${code}.html`);
  else if (!(await readFile(file, 'utf8')).includes(content + (kind === 'google' ? `google${code}.html` : code))) {
    errors.push(`файл ${prefix}${code}.html не содержит код подтверждения`);
  } else info.push(`${kind}: файл подтверждения на месте`);
}

// --- итог ---
const totalBytes = (await Promise.all(files.map((f) => stat(f).then((s) => s.size)))).reduce((a, b) => a + b, 0);
info.push(`страниц: ${htmlFiles.length}, файлов: ${files.length}`);
info.push(`размер dist: ${(totalBytes / 1024 / 1024).toFixed(1)} МБ`);
if (warnings.length) {
  console.log('ПРЕДУПРЕЖДЕНИЯ:');
  for (const w of warnings) console.log('  ! ' + w);
}
if (errors.length) {
  console.log('ОШИБКИ:');
  for (const e of errors) console.log('  x ' + e);
}
console.log(`\nПроверено: ${info.join('; ')}`);
console.log(errors.length ? `ПРОВЕРКА НЕ ПРОЙДЕНА: ${errors.length} ошибок, ${warnings.length} предупреждений` : `ПРОВЕРКА ПРОЙДЕНА: ошибок нет, предупреждений ${warnings.length}`);
if (errors.length || (strict && warnings.length)) process.exit(1);
