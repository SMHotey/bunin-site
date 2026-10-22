import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { api } from './wiki.mjs';
import { cleanWiki, templateField } from './clean.mjs';

// Импорт произведений И. А. Бунина с Викитеки.
// Страница автора: «Поэзия» → подсекции «Стихи ГГ—ГГ» (стихи inline, {{poemx}});
// «Проза» → список «Рассказы:». Часть прозы лежит текстом на странице,
// часть — только заголовком {{ПСС И. А. Бунина (1915)}} с djvu-сканом:
// для неё берём рендер подстраницы «/ПСС 1915 (ВТ)» (современная орфография).

const AUTHOR = 'Автор:Иван Алексеевич Бунин';
const WIKI = 'https://ru.wikisource.org/wiki/';
const CACHE = 'data/raw-cache.json';
const RENDERCACHE = 'data/render-cache.json';
const ENTRIES = 'data/entries.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sectionMap(text) {
  const lines = text.split('\n');
  let h2 = '', h3 = '';
  const out = [];
  for (const line of lines) {
    const m3 = line.match(/^===\s*([^=]+?)\s*===\s*$/);
    const m2 = line.match(/^==\s*([^=]+?)\s*==\s*$/);
    if (m3) { h3 = m3[1]; continue; }
    if (m2) { h2 = m2[1]; h3 = ''; continue; }
    out.push({ line, h2, h3 });
  }
  return out;
}

function slugify(s) {
  return s.toLowerCase().replace(/ё/g, 'е')
    .replace(/[«»"']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
}

// «Название (Бунин)» / «Костёр (Бунин: рассказ)»
const WORK_RE = /\(Бунин[^)]*\)$/;

function parseEntries(authorWikitext) {
  const entries = new Map(); // title -> {title, label, genre, year}
  for (const { line, h2, h3 } of sectionMap(authorWikitext)) {
    let genre = null;
    let year = null;
    if (h2 === 'Поэзия' && /^Стихи\s+\d{4}/.test(h3 || '')) {
      genre = 'Стихотворение';
      const y = (line.match(/''[«»]?(\d{4})/) || [])[1];
      year = y ? Number(y) : null;
    } else if (h2 === 'Проза') {
      genre = 'Рассказ';
      const y = (line.match(/(?:,|\s)(\d{4})/) || [])[1];
      year = y ? Number(y) : null;
    } else {
      continue;
    }
    if (!line.startsWith('*')) continue;
    const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;
    let m;
    while ((m = re.exec(line))) {
      const target = m[1].trim();
      if (/^(Категория|Файл|Image|Изображение):/i.test(target)) continue;
      if (!WORK_RE.test(target)) continue;
      let label = (m[2] || target.replace(/\s*\(Бунин[^)]*\)$/, '')).replace(/'''?/g, '').trim();
      label = label.replace(/^[«"]/, '').replace(/[»"]$/, '');
      if (!entries.has(target)) entries.set(target, { title: target, label, genre, year });
    }
  }
  return entries;
}

async function fetchWikitexts(titles, cache) {
  const missing = titles.filter((t) => !cache[PAGE_ALIASES[t] || t]);
  console.log(`текстов нет в кэше: ${missing.length} из ${titles.length}`);
  for (let i = 0; i < missing.length; i += 10) {
    const chunk = missing.slice(i, i + 10).map((t) => PAGE_ALIASES[t] || t);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const data = await api({
          action: 'query', prop: 'revisions', rvslots: 'main', rvprop: 'content',
          titles: chunk.join('|'), redirects: '1',
        });
        const redirects = data.query?.redirects || [];
        const norm = data.query?.normalized || [];
        const byTitle = new Map((data.query?.pages || []).map((p) => [p.title, p]));
        for (const t of chunk) {
          let key = t;
          const n = norm.find((x) => x.from === t); if (n) key = n.to;
          const r = redirects.find((x) => x.from === key); if (r) key = r.to;
          const p = byTitle.get(key);
          const content = p?.revisions?.[0]?.slots?.main?.content;
          if (content) cache[t] = content;
        }
        break;
      } catch (e) {
        console.warn('retry chunk', i, e.message);
        await sleep(3000 * (attempt + 1));
      }
    }
    await sleep(700);
    if (Math.floor(i / 10) % 5 === 0) console.log(`${i + chunk.length}/${missing.length}`);
  }
}

const ENTITIES = {
  '&nbsp;': ' ', '&#160;': ' ', '&mdash;': '—', '&ndash;': '–',
  '&laquo;': '«', '&raquo;': '»', '&quot;': '"', '&ldquo;': '“', '&rdquo;': '”',
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&shy;': '', '&#91;': '[', '&#93;': ']',
  '&#x2007;': ' ', '&#8199;': ' ', '&#x2009;': ' ', '&#8201;': ' ',
  '&#8239;': ' ', '&#x202f;': ' ',
};

function decodeEntities(s) {
  return s.replace(/&(?:nbsp|mdash|ndash|laquo|raquo|quot|ldquo|rdquo|amp|lt|gt|shy);|&#\d+;|&#x[0-9a-fA-F]+;/g,
    (m) => ENTITIES[m] ?? (m.startsWith('&#x') || m.startsWith('&#X')
      ? String.fromCodePoint(parseInt(m.slice(2, -1), 16))
      : String.fromCharCode(Number(m.slice(2, -1)))));
}

// Дореформенная орфография → современная (для ранних текстов без ВТ-редакции).
function modernizeOrthography(t) {
  return t
    .replace(/ѣ/g, 'е').replace(/ѳ/g, 'ф').replace(/ѵ/g, 'и').replace(/і/g, 'и')
    .replace(/(\p{L})ъ(?=[\s\p{P}]|$)/gu, '$1');
}

// Очистка отрендерённого HTML подстраницы djvu-редакции.
function cleanRenderedHtml(html) {
  let h = html;
  const t = h.indexOf('<div class="text"');
  if (t !== -1) h = h.slice(t);
  const end = h.lastIndexOf('</div>');
  if (end !== -1) h = h.slice(0, end);
  // маркеры страниц скана: [<a ...>163</a>]
  h = h.replace(/\[\s*<a [^>]*>\s*\d+\s*<\/a>\s*\]/g, '');
  h = h.replace(/<(style|link|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<(?:style|link|script)\b[^>]*\/?>/gi, '');
  h = h.replace(/<\s*(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, '\n');
  h = h.replace(/<[^>]+>/g, '');
  h = decodeEntities(h);
  h = h.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
  return h.replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchRendered(subpage, rcache) {
  if (rcache[subpage] !== undefined) return rcache[subpage];
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const data = await api({ action: 'parse', page: subpage, prop: 'text' });
      if (data.error) { rcache[subpage] = null; return null; }
      const html = data.parse?.text;
      rcache[subpage] = typeof html === 'string' ? html : (html?.['*'] ?? null);
      return rcache[subpage];
    } catch (e) {
      console.warn('retry render', subpage, e.message);
      await sleep(2500 * (attempt + 1));
    }
  }
  return null;
}

// Крупные повести, перечисленные на странице автора как «Рассказы»
const NOT_STORY = { 'Деревня': 'Повесть', 'Суходол': 'Повесть' };

// Страницы викитеки, названные иначе, чем ссылка на странице автора
// («Кукушка», «Помпея» и рассказ «Костёр» на викитеке отсутствуют).
const PAGE_ALIASES = {
  'Вести с Родины (Бунин)': 'Вести с родины (Бунин)',
};

async function main() {
  await mkdir('data', { recursive: true });

  console.log('страница автора...');
  const authorWikitext = await api({ action: 'parse', page: AUTHOR, prop: 'wikitext' })
    .then((d) => (typeof d.parse.wikitext === 'string' ? d.parse.wikitext : d.parse.wikitext['*']));
  const entries = parseEntries(authorWikitext);
  console.log('произведений на странице автора:', entries.size);

  const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {};
  await fetchWikitexts([...entries.keys()], cache);
  await writeFile(CACHE, JSON.stringify(cache), 'utf8');
  await writeFile(ENTRIES, JSON.stringify([...entries.values()], null, 1), 'utf8');

  const rcache = existsSync(RENDERCACHE) ? JSON.parse(await readFile(RENDERCACHE, 'utf8')) : {};
  const works = [];
  let renders = 0;

  for (const meta of entries.values()) {
    const page = PAGE_ALIASES[meta.title] || meta.title;
    const raw = cache[page];
    if (!raw) { console.warn('MISS', meta.title); continue; }

    let text = null;
    let published = templateField(raw, 'ДАТАПУБЛИКАЦИИ') || null;
    let source = templateField(raw, 'ИСТОЧНИК') || null;
    let sourceUrl = WIKI + encodeURIComponent(meta.title.replace(/ /g, '_'));
    const isPssStub = /\{\{\s*ПСС И\. А\. Бунина/.test(raw) || raw.trim().length < 600;

    if (isPssStub) {
      // djvu-заголовок: текст на подстранице «/ПСС 1915 (ВТ)» (совр. орфография),
      // при её отсутствии — «/ПСС 1915 (ДО)».
      const base = meta.title;
      let html = await fetchRendered(`${base}/ПСС 1915 (ВТ)`, rcache);
      let subpage = `${base}/ПСС 1915 (ВТ)`;
      if (!html) {
        html = await fetchRendered(`${base}/ПСС 1915 (ДО)`, rcache);
        subpage = `${base}/ПСС 1915 (ДО)`;
      }
      if (html) {
        text = cleanRenderedHtml(html);
        sourceUrl = WIKI + encodeURIComponent(subpage.replace(/ /g, '_'));
        const pm = html.match(/Опубл\.:.*?ws-published[^>]*>([^<]+)</);
        if (pm) published = pm[1].trim();
        if (!source) source = 'Бунин И. А. Полное собрание сочинений: в 6 т. — Пг.: Изд. т-ва А. Ф. Маркс, 1915. Т. 2 (Викитека, djvu)';
        renders++;
        await sleep(700);
      } else {
        console.warn('NO RENDER', meta.title);
        continue;
      }
    } else {
      text = cleanWiki(raw);
    }

    if (!text || text.length < 100) { console.warn('short', meta.title, text?.length); continue; }
    // убрать служебные хвосты викитеки
    text = text.replace(/\{\{[^{}]*\}\}/g, '').trim();
    // ранние djvu-тексты в дореформенной орфографии — привести к современной
    // (триггер — ѣ/ѳ или твёрдый знак в конце слова; украинские «і» в диалектных репликах не трогаем)
    if (/[ѣѳ]/.test(text) || /\p{L}ъ(?=[\s\p{P}]|$)/u.test(text)) text = modernizeOrthography(text);

    const genre = NOT_STORY[meta.label] || meta.genre;
    works.push({
      title: meta.label,
      slug: slugify(meta.label),
      genre,
      year: meta.year,
      published,
      text,
      chars: text.length,
      sourceUrl,
      source,
    });
  }

  const seen = new Set();
  const unique = works.filter((w) => { if (seen.has(w.slug)) return false; seen.add(w.slug); return true; });
  unique.sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.title.localeCompare(b.title, 'ru'));

  await writeFile('data/works.json', JSON.stringify(unique, null, 1), 'utf8');
  const byGenre = {};
  unique.forEach((w) => (byGenre[w.genre] = (byGenre[w.genre] || 0) + 1));
  console.log('written:', unique.length, byGenre, '| djvu-рендеров:', renders,
    '| без года:', unique.filter((w) => !w.year).length);
}

main().catch((e) => { console.error(e); process.exit(1); });
