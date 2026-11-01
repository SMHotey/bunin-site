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

// --- тексты произведений ---
// Импорт с Викитеки оставлял <ref> в параметрах шаблонов, «== 1 ==» и __NOTOC__ —
// на странице это мусор. Гейт, чтобы чистка не откатилась при следующем импорте.
const worksData = await readJson('data/works.json');
for (const w of worksData) {
  const t = String(w.text || '');
  if (/<\/?[a-zA-Z][^>]*>/.test(t)) errors.push(`works.json: ${w.slug} — сырые HTML-теги в тексте произведения`);
  if (/(?:^|\n)__\w+__/.test(t)) errors.push(`works.json: ${w.slug} — wiki-хелперы (__NOTOC__) в тексте`);
  if (/(?:^|\n)==+[^=\n]+==+\s*(?:\n|$)/.test(t)) errors.push(`works.json: ${w.slug} — wiki-заголовки «== … ==» в тексте`);
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

// --- служебные файлы ---
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
