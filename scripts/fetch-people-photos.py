# -*- coding: utf-8 -*-
"""Добор портретов персон с Викисклада (Commons) с лицензией в метаданных.

Поиск идёт через generator=search по пространству файлов; берём только файлы
со свободной лицензией (public domain / CC0 / CC BY / CC BY-SA), скачиваем
900 px, сжимаем в JPEG и пишем data/people-photos.json (не перезаписывая уже
собранные записи).

Запуск: python scripts/fetch-people-photos.py "id=поисковый запрос" ...
"""
import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

from PIL import Image

API = 'https://commons.wikimedia.org/w/api.php'
UA = 'poet-bunin.ru/1.0 (educational site; contact via site)'
OK_LICENSES = ('public domain', 'pd', 'cc0', 'cc by', 'cc-by', 'cc by-sa', 'cc-by-sa')


def api(params):
    params = dict(params, format='json')
    url = API + '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.load(r)


def search(term, limit=12):
    data = api({
        'action': 'query', 'generator': 'search', 'gsrnamespace': 6,
        'gsrsearch': term, 'gsrlimit': limit, 'prop': 'imageinfo',
        'iiprop': 'url|extmetadata|size', 'iiurlwidth': 900,
    })
    return list((data.get('query', {}).get('pages') or {}).values())


def license_of(info):
    meta = info.get('extmetadata') or {}
    short = (meta.get('LicenseShortName', {}).get('value') or '').strip()
    return short


def credit_of(info):
    meta = info.get('extmetadata') or {}
    artist = (meta.get('Artist', {}).get('value') or '').strip()
    # в Artist обычно HTML — снимаем теги грубо, этого достаточно для подписи
    import re
    artist = re.sub(r'<[^>]+>', '', artist).strip()
    return artist or 'Unknown author'


def pick(pages):
    scored = []
    for p in pages:
        info = (p.get('imageinfo') or [{}])[0]
        lic = license_of(info)
        if not any(lic.lower().startswith(x) for x in OK_LICENSES):
            continue
        title = p['title']
        if not title.lower().endswith(('.jpg', '.jpeg', '.png')):
            continue
        w = info.get('width') or 0
        h = info.get('height') or 0
        if w < 250 or h < 250:
            continue
        portrait = 1.0 if h > w else 0.75  # вертикальный портрет предпочтительнее
        scored.append((portrait * min(w, 1600), p, info, lic))
    scored.sort(key=lambda x: -x[0])
    return scored[0] if scored else None


def download(url, dst, max_side=900):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    im = Image.open(io.BytesIO(raw)).convert('RGB')
    im.thumbnail((max_side, max_side))
    im.save(dst, 'JPEG', quality=84)
    return im.size


def main(pairs):
    path = 'data/people-photos.json'
    data = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
    os.makedirs('public/img/people', exist_ok=True)
    for pair in pairs:
        pid, term = pair.split('=', 1)
        if data.get(pid, {}).get('photo'):
            print('уже есть:', pid)
            continue
        try:
            best = pick(search(term))
        except Exception as e:
            print('ошибка поиска', pid, e)
            continue
        if not best:
            print('не найдено со свободной лицензией:', pid, term)
            continue
        _, page, info, lic = best
        dst = f'public/img/people/{pid}.jpg'
        try:
            w, h = download(info['thumburl'] if info.get('thumburl') else info['url'], dst)
        except Exception as e:
            print('ошибка скачивания', pid, e)
            continue
        data[pid] = {
            'photo': f'/img/people/{pid}.jpg',
            'photoAlt': term,
            'photoCredit': f'Фото: {credit_of(info)}, Wikimedia Commons, {lic}',
            'photoLicense': lic,
            'photoSource': f"https://commons.wikimedia.org/wiki/{urllib.parse.quote(page['title'].replace(' ', '_'))}",
            'photoW': w,
            'photoH': h,
        }
        print('ок:', pid, page['title'], lic, w, h)
        time.sleep(0.4)
    json.dump(data, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main(sys.argv[1:] or ['lyudmila-aleksandrovna=Людмила Александровна Бунина'])
