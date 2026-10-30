#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Загрузка фото с Викисклада для карточек разделов (музеи, памятники, подборки).

Что делает:
  1) берёт список файлов из MEDIA ниже, проверяет свободную лицензию;
  2) скачивает шириной 1400 px, сохраняет JPEG + WebP в public/img/<папка>/;
  3) прописывает в data/museums.json / monuments.json / topics.json поля
     photo, photoWebp, photoAlt, photoCredit, photoLicense, photoSource.

Особенности:
  - сеть через curl: на этой машине python ssl падает на сертификате Викисклада;
  - пауза между запросами: Викисклад отвечает 429 на частые обращения;
  - идемпотентно: уже скачанный файл не перекачивается (сброс — флагом --force).

Запуск: python scripts/import-media.py [--force] [--only ключ]
"""
import io
import json
import os
import subprocess
import sys
import time
import urllib.parse

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "https://commons.wikimedia.org/w/api.php"
UA = "poet-bunin.ru/1.0 (educational site; media import)"
WIDTH = 1400
DELAY = 2.0
FORCE = "--force" in sys.argv
ONLY = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else ""

# папка, ключ записи в данных, файл на Викискладе, alt
MEDIA = [
    ("museums", "efremov-museum", "File:House-Museum of Ivan Bunin facade.JPG",
     "Дом-музей И. А. Бунина в Ефремове"),
    ("monuments", "voronezh-sculpture", "File:Памятник Бунину. Воронеж.jpg",
     "Памятник Ивану Бунину в Воронеже"),
    ("monuments", "orel-sculpture", "File:Памятник Бунину в Орле.jpg",
     "Памятник Ивану Бунину в Орле"),
    ("monuments", "grasse-monument", "File:Памятник И.А.Бунину в г. Грассе (Франция).jpg",
     "Памятник Ивану Бунину в Грасе"),
]


def curl(url, binary=False, tries=5):
    delay = 3.0
    for a in range(tries):
        p = subprocess.run(["curl", "-s", "--max-time", "90", "-A", UA, url],
                           capture_output=True)
        if p.returncode == 0 and p.stdout:
            if not binary and b"too many requests" in p.stdout[:200].lower():
                print("   лимит Викисклада, ждём %.0f c" % delay)
                time.sleep(delay)
                delay = min(delay * 2, 40)
                continue
            return p.stdout
        time.sleep(delay)
        delay = min(delay * 2, 40)
    raise SystemExit("не удалось скачать: " + url[:120])


def metadata(title):
    params = {"action": "query", "format": "json", "titles": title,
              "prop": "imageinfo", "iiprop": "url|size|extmetadata", "iiurlwidth": WIDTH}
    d = json.loads(curl(API + "?" + urllib.parse.urlencode(params)).decode("utf-8"))
    page = next(iter(d["query"]["pages"].values()))
    ii = (page.get("imageinfo") or [None])[0]
    if not ii:
        raise SystemExit("нет imageinfo: " + title)
    em = ii.get("extmetadata", {})

    def field(name):
        raw = em.get(name, {}).get("value", "")
        import re
        return re.sub(r"<[^>]+>", "", str(raw)).strip()

    return {
        "thumb": ii.get("thumburl") or ii.get("url"),
        "descurl": ii.get("descriptionurl"),
        "artist": field("Artist"),
        "license": field("LicenseShortName"),
        "credit": field("Credit"),
    }


LICENSE_OK = ("public domain", "cc0", "cc by", "cc-by", "pd", "no restrictions")


def save(folder, key, raw):
    img = Image.open(io.BytesIO(raw))
    img = img.convert("RGB")
    if img.width > WIDTH:
        h = round(img.height * WIDTH / img.width)
        resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS")
        img = img.resize((WIDTH, h), resample)
    out_dir = os.path.join(ROOT, "public", "img", folder)
    os.makedirs(out_dir, exist_ok=True)
    jpg = os.path.join(out_dir, key + ".jpg")
    webp = os.path.join(out_dir, key + ".webp")
    img.save(jpg, "JPEG", quality=82, optimize=True, progressive=True)
    img.save(webp, "WEBP", quality=78, method=5)
    return "/img/%s/%s.jpg" % (folder, key), "/img/%s/%s.webp" % (folder, key), img.size


def apply(folder, key, photo, webp, alt, meta):
    path = os.path.join(ROOT, "data", folder + ".json")
    data = json.load(open(path, encoding="utf-8"))
    target = None
    for item in data:
        if item.get("id") == key:
            target = item
            break
    if target is None:
        raise SystemExit("нет записи %s в %s" % (key, folder + ".json"))
    target["photo"] = photo
    target["photoWebp"] = webp
    target["photoAlt"] = alt
    target["photoCredit"] = (meta["artist"] or meta["credit"] or "Wikimedia Commons")[:120]
    target["photoLicense"] = meta["license"]
    target["photoSource"] = meta["descurl"]
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")
    return target


def main():
    done = 0
    for folder, key, title, alt in MEDIA:
        if ONLY and key != ONLY:
            continue
        jpg_path = os.path.join(ROOT, "public", "img", folder, key + ".jpg")
        if os.path.exists(jpg_path) and not FORCE:
            print("  %-20s уже есть, пропуск" % key)
            continue
        print("  %-20s %s" % (key, title))
        meta = metadata(title)
        lic = meta["license"].lower()
        if not any(x in lic for x in LICENSE_OK):
            print("    ЛИЦЕНЗИЯ НЕ ПОДХОДИТ: %s — пропуск" % meta["license"])
            continue
        time.sleep(DELAY)
        raw = curl(meta["thumb"], binary=True)
        photo, webp, size = save(folder, key, raw)
        apply(folder, key, photo, webp, alt, meta)
        print("    %s %dx%d | %s" % (photo, size[0], size[1], meta["license"]))
        done += 1
        time.sleep(DELAY)
    print("готово:", done, "файлов")


if __name__ == "__main__":
    main()
