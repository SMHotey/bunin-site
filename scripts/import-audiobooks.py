#!/usr/bin/env python3
# Импорт аудиокниг из ЛитРеса: каталог → метаданные → партнёрские ссылки → data/audiobooks.json
#
# Что делает:
#   1. Ищет аудиокниги Бунина в поиске ЛитРеса (несколько запросов + пагинация);
#   2. Открывает страницу каждого товара и читает schema.org-разметку Audiobook
#      (название, чтецы, длительность, год, издатель, обложка);
#   3. Отсекает мусор: чужих авторов, сборники-антологии с другими поэтами,
#      робота-чтеца («Авточтец»), отсутствующие в продаже и обрезки короче 10 минут;
#   4. Собирает партнёрскую ссылку под каждый товар через Cakelink API AdvCake
#      (ключ берётся из .secrets/advcake.key или переменной ADVCAKE_API_KEY);
#   5. Скачивает обложки в public/img/audiobooks (JPEG + WebP).
#
# Выход: data/audiobooks.json — ровно тот формат, который читает scripts/build.mjs.
# Запуск: python scripts/import-audiobooks.py [--no-download] [--refresh] [--limit N]
import argparse
import hashlib
import html
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data", "audiobooks.json")
COVERS = os.path.join(ROOT, "public", "img", "audiobooks")
CACHE = os.path.join(ROOT, ".cache", "litres")
KEY_FILE = os.path.join(ROOT, ".secrets", "advcake.key")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
      "Accept-Language": "ru-RU,ru;q=0.9"}

SEARCH_QUERIES = ["бунин", "бунин рассказы", "бунин тёмные аллеи", "бунин повести",
                  "бунин окаянные дни", "бунин стихи", "бунин проза",
                  "бунин собрание сочинений", "бунин аудиоспектакль", "жизнь арсеньева"]
MAX_PAGES = 4
MIN_MINUTES = 12          # короче — это фрагмент на пару минут, карточке не место
ROBOT_NARRATOR = re.compile(r"вточтец|искусственн\w*\s+интеллект|нейросет|алгебра слова", re.I)
CYRILLIC = re.compile(r"[А-Яа-яЁё]")

# ---------- категории ----------

CATEGORY_RULES = [
    ("Аудиоспектакль", r"аудиоспектакл|спектакл|радиоспектакл|инсценировк"),
    ("Дневники и публицистика", r"окаянные дни|дневник|^чехов$|воспоминани|автобиографическ|нобелевские дни|публицист|заметки|письма"),
    ("Собрание сочинений", r"собрани[ея] сочинени|полное собрание|сочинения в \d+"),
    ("Избранное", r"избранн|лучшие|шедевры"),
    ("Рассказы", r"сборник"),
    ("Проза и стихи", r"проза[^|]{0,12}поэзи|поэзи[^|]{0,12}проза|рассказы[^|]{0,8}стих"),
    ("Стихотворения", r"^стих|стихотворени|лирика"),
    ("Повести и романы", r"повест|жизнь арсеньева|три повести|^деревня$|^суходол$|митина любовь"),
]

# В прозе Бунина «Поэма» и «Поэма в прозе» — не отдельный жанр: правило нужно только
# для совместимости с общей логикой аннотаций, поэм у Бунина в каталоге нет.
SINGLE_POEM = re.compile(r"(?!x)x")

ANNOTATIONS = {
    "Рассказы": [
        "Один рассказ целиком — можно послушать за одну поездку.",
        "Короткая проза Бунина: сюжет держится на деталях, а не на событиях.",
        "Рассказ без сокращений, в том виде, в каком он и был напечатан.",
        "Малая форма: один эпизод, много воздуха и точная последняя строка.",
        "Сборник рассказов — удобно слушать по одному, а не подряд.",
    ],
    "Повести и романы": [
        "Крупная форма: одна история на много часов, без сборных нарезок.",
        "Повесть целиком — там, где у Бунина важнее длительность, а не поворот сюжета.",
        "Несколько глав жизни подряд: читается как роман, даже если это повесть.",
        "Большая вещь в непрерывном чтении: слышно, как накапливается время.",
    ],
    "Дневники и публицистика": [
        "Не проза для чтения вслух, а документ: записи по горячему следу.",
        "Дневник и статьи — Бунин как свидетель, а не как рассказчик.",
        "Публицистика и заметки: здесь важны даты и имена, а не сюжет.",
        "Документальная сторона Бунина: то, что осталось за пределами рассказов.",
    ],
    "Стихотворения": [
        "Бунин-поэт: пейзаж, осень, дорога — та интонация, которая потом ушла в прозу.",
        "Стихи, написанные параллельно с рассказами: другая манера, та же точность.",
        "Лирика без прозы: короткие тексты с очень плотной рифмой.",
    ],
    "Проза и стихи": [
        "Смешанный состав: рассказы и стихотворения в одной записи.",
        "И проза, и стихи — смотря что вошло в конкретное издание.",
    ],
    "Избранное": [
        "Отобранное главное — если нужна одна запись, а не собрание.",
        "Быстрый вход в Бунина: то, что чаще всего ищут и цитируют.",
        "Избранные вещи разных лет: видно и раннего Бунина, и эмигрантского.",
    ],
    "Собрание сочинений": [
        "Большой свод: слушать подряд, как книгу жизни, а не как подборку.",
        "Многочасовая запись основного корпуса — для долгого слушания и для сверки.",
        "Полное собрание одной записью: корпус текстов без выбора составителя.",
    ],
    "Аудиоспектакль": [
        "Не чтение, а спектакль: роли, музыка, шумы — текст воспринимается как действие.",
        "Инсценировка с актёрским составом: несколько голосов вместо одного чтеца.",
        "Аудиоспектакль по Бунину — самый простой способ услышать прозу «в лицах».",
    ],
}

def category_of(title: str) -> str:
    low = title.lower()
    for name, pattern in CATEGORY_RULES:
        if re.search(pattern, low):
            return name
    return "Рассказы"


def minutes_of(duration: str):
    """PT2H27M → 147, PT28M → 28, PT1H → 60."""
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?", duration or "")
    if not m:
        return None
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)


def duration_text(minutes: int) -> str:
    h, m = divmod(minutes, 60)
    if h and m:
        return f"{h} ч {m} мин"
    if h:
        return f"{h} ч"
    return f"{m} мин"


def annotate(cat: str, reader: str, minutes: int, year, title: str = "") -> str:
    """Своя короткая аннотация: текст из пула по категории.

    Чтеца и длительность в текст не дублируем — они уже в мете карточки.
    """
    pool_cat = cat
    if cat == "Повести и романы" and SINGLE_POEM.search(title):
        pool_cat = "Поэма"
    variants = ANNOTATIONS.get(pool_cat) or ANNOTATIONS["Рассказы"]
    seed = f"{cat}|{reader}|{minutes}|{year}"
    idx = int(hashlib.md5(seed.encode()).hexdigest(), 16) % len(variants)
    return variants[idx]


# ---------- сеть ----------

def fetch(url: str, tries: int = 3) -> bytes:
    last = None
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=45) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{type(last).__name__}: {last}")


def cached_html(pid: str, url: str, refresh: bool) -> str:
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{pid}.html")
    if not refresh and os.path.exists(path) and time.time() - os.path.getmtime(path) < 30 * 86400:
        return open(path, encoding="utf-8", errors="ignore").read()
    raw = fetch(url).decode("utf-8", errors="ignore")
    open(path, "w", encoding="utf-8").write(raw)
    time.sleep(0.4)
    return raw


def next_flight_blob(raw: str) -> str:
    """Next.js отдаёт данные в self.__next_f.push([1,"…"]) — склеиваем все чанки."""
    chunks = re.findall(r'self\.__next_f\.push\(\[1,"(.*?)"\]\)', raw, flags=re.S)
    out = []
    for c in chunks:
        try:
            out.append(json.loads('"' + c + '"'))
        except Exception:  # noqa: BLE001
            continue
    return "".join(out)


def search_page(query: str, page: int):
    url = ("https://www.litres.ru/search/?q=" + urllib.parse.quote(query) +
           f"&art_types=audiobook&page={page}")
    raw = fetch(url).decode("utf-8", errors="ignore")
    blob = next_flight_blob(raw)
    items = []
    for m in re.finditer(r'\{"id":\d+,"uuid":"[^"]*","cover_url":"[^"]*"', blob):
        start = m.start()
        obj = json_scan(blob, start)
        if obj and obj.get("art_type") == 1 and obj.get("url", "").startswith("/audiobook/"):
            items.append(obj)
    return items


def json_scan(s: str, start: int):
    """Читает один JSON-объект, начиная с позиции start, и возвращает dict."""
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        else:
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(s[start:i + 1])
                    except Exception:  # noqa: BLE001
                        return None
    return None


def product(url: str, pid: str, refresh: bool):
    raw = cached_html(pid, url, refresh)
    blocks = re.findall(r'<script type="application/ld\+json"[^>]*>(.*?)</script>', raw, flags=re.S)
    for b in blocks:
        try:
            d = json.loads(b)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(d, dict) and d.get("@type") in ("Audiobook", "Book"):
            return d
    return None


# ---------- партнёрские ссылки ----------

def api_key() -> str:
    key = os.environ.get("ADVCAKE_API_KEY", "").strip()
    if key:
        return key
    if os.path.exists(KEY_FILE):
        return open(KEY_FILE, encoding="utf-8").read().strip()
    sys.exit("Нет ключа AdvCake: положите его в .secrets/advcake.key или в ADVCAKE_API_KEY")


def cakelink(deep_url: str, key: str) -> str:
    """Cakelink превращает диплинк в партнёрскую ссылку с метками и erid."""
    api = ("https://cakelink.ru/link?dl=" + urllib.parse.quote(deep_url, safe="") +
           "&pass=" + urllib.parse.quote(key, safe=""))
    data = json.loads(fetch(api).decode("utf-8"))
    if not data.get("success"):
        raise RuntimeError(f"cakelink: {data}")
    payload = data.get("data")
    if isinstance(payload, list):
        payload = payload[0]
    return payload["url"]


# ---------- обложки ----------

def save_cover(pid: str, image_url: str) -> dict:
    os.makedirs(COVERS, exist_ok=True)
    name = f"audio-{pid}"
    jpg = os.path.join(COVERS, name + ".jpg")
    webp = os.path.join(COVERS, name + ".webp")
    raw = fetch(image_url)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    if img.width > 600:
        img = img.resize((600, round(img.height * 600 / img.width)), Image.LANCZOS)
    img.save(jpg, "JPEG", quality=84, optimize=True, progressive=True)
    img.save(webp, "WEBP", quality=82, method=6)
    return {"cover": f"/img/audiobooks/{name}.jpg",
            "coverWebp": f"/img/audiobooks/{name}.webp",
            "coverWidth": img.width, "coverHeight": img.height}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-download", action="store_true", help="не скачивать обложки и обновлять ссылки")
    ap.add_argument("--refresh", action="store_true", help="перекачать страницы товаров, игнорируя кэш")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    # 1. поиск (результаты неделю лежат в кэше: повторный запуск не дёргает ЛитРес зря)
    os.makedirs(CACHE, exist_ok=True)
    cache_file = os.path.join(CACHE, "search.json")
    found = {}
    if not args.refresh and os.path.exists(cache_file) and time.time() - os.path.getmtime(cache_file) < 7 * 86400:
        found = {int(k): v for k, v in json.load(open(cache_file, encoding="utf-8")).items()}
        print(f"  поиск из кэша: {len(found)} товаров")
    else:
        for q in SEARCH_QUERIES:
            for page in range(1, MAX_PAGES + 1):
                items = search_page(q, page)
                new = 0
                for it in items:
                    if it["id"] not in found:
                        found[it["id"]] = it
                        new += 1
                print(f"  поиск «{q}» стр.{page}: +{new} (всего {len(found)})", flush=True)
                if not new:
                    break
        json.dump({str(k): v for k, v in found.items()}, open(cache_file, "w", encoding="utf-8"), ensure_ascii=False)

    # 2. отбор кандидатов: Бунин как автор или книга о нём
    cands = []
    for it in found.values():
        authors = [p.get("full_name", "") for p in it.get("persons", []) if p.get("role") == "author"]
        if any("Иван Бунин" == a for a in authors) or "бунин" in it["title"].lower().replace("ё", "е"):
            cands.append(it)
    cands.sort(key=lambda x: x["id"])
    print(f"кандидатов: {len(cands)}")

    # Аннотации редакционные (переписаны по описанию ЛитРеса): при повторном импорте
    # сохраняем уже готовый текст, иначе карточки снова станут одинаковыми.
    prev_map = {x["id"]: x for x in (json.load(open(OUT, encoding="utf-8")) if os.path.exists(OUT) else [])}
    key = "" if args.no_download else api_key()
    books = []
    skipped = {"продажа": 0, "робот": 0, "коротко": 0, "чужое": 0, "без чтеца": 0, "без данных": 0}
    for n, it in enumerate(cands, 1):
        pid = str(it["id"])
        url = "https://www.litres.ru" + it["url"]
        try:
            ld = product(url, pid, args.refresh)
        except Exception as e:  # noqa: BLE001
            print(f"  ! {pid}: {e}")
            ld = None
        if not ld:
            skipped["без данных"] += 1
            continue

        authors = ld.get("author")
        authors = authors if isinstance(authors, list) else ([authors] if authors else [])
        author_names = [a.get("name", "") for a in authors if isinstance(a, dict)]
        title = html.unescape(ld.get("name") or it["title"]).strip()

        # антологии с другими авторами — не наши; чужие однофамильцы (Николай и П. Бунины) — тоже
        if "Иван Бунин" not in author_names:
            skipped["чужое"] += 1
            continue
        if len(author_names) > 1 and "бунин" not in title.lower().replace("ё", "е"):
            skipped["чужое"] += 1
            continue

        reader_obj = ld.get("readBy")
        readers = reader_obj if isinstance(reader_obj, list) else ([reader_obj] if reader_obj else [])
        readers = [r.get("name", "").strip() for r in readers if isinstance(r, dict) and r.get("name")]
        # Робот-чтец и любительские записи под ником: у Бунина такого добра много.
        if any(ROBOT_NARRATOR.search(r) for r in readers):
            skipped["робот"] += 1
            continue
        if any(not CYRILLIC.search(r) for r in readers):
            skipped["робот"] += 1
            continue
        if not readers:
            # Карточка аудиокниги без чтеца выглядит недоделанной — такие записи не берём.
            skipped["без чтеца"] += 1
            continue

        minutes = minutes_of(ld.get("duration"))
        if not minutes or minutes < MIN_MINUTES:
            skipped["коротко"] += 1
            continue

        offers = ld.get("offers") or {}
        availability = "InStock" if str(offers.get("availability", "")).endswith("InStock") else "OutOfStock"
        if availability != "InStock":
            skipped["продажа"] += 1
            continue

        cat = category_of(title)
        year = str(ld.get("datePublished") or "")[:4]
        reader_text = ", ".join(readers)

        book = {
            "id": f"audio-{pid}",
            "productId": pid,
            "title": title,
            "format": "Аудиокнига",
            "category": cat,
            "publisher": "ЛитРес",
            "year": year,
            "duration": duration_text(minutes),
            "durationMinutes": minutes,
            "performer": reader_text,
            "readers": readers,
            "stores": ["litres"],
            "productUrl": url,
            "searchQuery": f"{' '.join(author_names) or 'Иван Бунин'} {title}",
            "tags": [duration_text(minutes), cat, "ЛитРес"],
            "availability": availability,
            "annotation": (prev_map.get(f"audio-{pid}") or {}).get("annotation")
            or annotate(cat, reader_text, minutes, year, title),
        }

        if not args.no_download:
            img_url = ld.get("image") or ("https://cdn2.litres.ru/pub/c/cover/" + pid + ".jpg")
            try:
                book.update(save_cover(pid, img_url))
                book["coverAlt"] = f"{title} — обложка аудиокниги"
                book["coverCredit"] = "Обложка: ЛитРес"
            except Exception as e:  # noqa: BLE001
                print(f"  ! обложка {pid}: {e}")
            try:
                link = cakelink(url, key)
                m = re.search(r"[?&]erid=([^&]+)", link)
                book["links"] = [{"store": "litres", "url": link, "erid": urllib.parse.unquote(m.group(1)) if m else ""}]
            except Exception as e:  # noqa: BLE001
                print(f"  ! ссылка {pid}: {e}")
        else:
            old = {b["id"]: b for b in (json.load(open(OUT, encoding="utf-8")) if os.path.exists(OUT) else [])}
            prev = old.get(book["id"])
            if prev:
                for k in ("cover", "coverWebp", "coverWidth", "coverHeight", "coverAlt", "coverCredit", "links"):
                    if k in prev:
                        book[k] = prev[k]
            if not book.get("links"):
                book["links"] = [{"store": "litres", "url": url}]

        if not book.get("links"):
            skipped["без данных"] += 1
            continue
        books.append(book)
        if n % 10 == 0:
            print(f"  обработано {n}/{len(cands)}, готово карточек {len(books)}", flush=True)
        if args.limit and len(books) >= args.limit:
            break

    books.sort(key=lambda b: (b["category"], b["title"]))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(books, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"готово: {len(books)} аудиокниг → {os.path.relpath(OUT, ROOT)}")
    print("отсеяно:", ", ".join(f"{k} — {v}" for k, v in skipped.items() if v))


if __name__ == "__main__":
    main()
