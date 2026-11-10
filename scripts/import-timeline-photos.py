#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Миниатюры для хронологии: квадратные превью 200×200 из уже имеющихся фотографий.

Событие в списке — одна строка, поэтому крупные снимки там не нужны: скрипт режет
квадрат по центру, сохраняет JPEG+WebP в public/img/thumbs/ и прописывает
photo / photoWebp / photoAlt в data/timeline.json. Новых загрузок нет.
Запуск: python scripts/import-timeline-photos.py
"""
import json, os

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "img", "thumbs")
SIZE = 200

# Событие (по заголовку из data/timeline.json) → (файл в public/, подпись).
# Ключ — заголовок, а не дата: в хронологии есть по два события на 1918 и 1930 год.
EVENTS = {
    'Рождение в Воронеже': ('/img/places/voronezh-birth.jpg', 'Воронеж, дом на Дворянской'),
    'Хутор Бутырки': ('/img/places/voronezh-plaque.jpg', 'Воронежский край'),
    'Елецкая гимназия': ('/img/places/yelets-gymnasium.jpg', 'Елецкая гимназия'),
    'Первая публикация': ('/img/places/oryol-museum.jpg', 'Орёл'),
    'Орёл': ('/img/places/oryol-museum.jpg', 'Орёл, музей Бунина'),
    'Первый сборник': ('/img/places/moscow-povarskaya.jpg', 'Москва, Поварская'),
    'Полтава': ('/img/places/oryol-museum.jpg', 'Орловщина'),
    'Первый Петербург': ('/img/places/moscow-povarskaya.jpg', 'Москва'),
    'Брак с Анной Цакни': ('/img/people/anna-tsakni.jpg', 'Анна Цакни'),
    'Ялта: Чехов и Горький': ('/img/people/chekhov.jpg', 'Антон Чехов'),
    '«Листопад»': ('/img/places/moscow-povarskaya.jpg', 'Москва'),
    'Пушкинская премия': ('/img/people/brusov.jpg', 'Валерий Брюсов'),
    'Смерть сына': ('/img/people/nikolai-bunin.jpg', 'Николай Бунин, сын'),
    'Знакомство с Верой Муромцевой': ('/img/people/vera-murmtseva.jpg', 'Вера Муромцева'),
    'Путешествие на Восток': ('/img/places/oryol-museum.jpg', 'Орловщина'),
    'Вторая премия и академик': ('/img/people/brusov.jpg', 'Валерий Брюсов'),
    'Начало «Деревни»': ('/img/places/moscow-povarskaya.jpg', 'Москва'),
    'Отъезд из Москвы': ('/img/places/moscow-povarskaya.jpg', 'Москва, Поварская'),
    'Пароход «Спарта»': ('/img/places/paris-house.jpg', 'Париж'),
    'Берлинский венчание': ('/img/people/vera-murmtseva.jpg', 'Вера Муромцева'),
    '«Митина любовь» и «Окаянные дни»': ('/img/places/paris-house.jpg', 'Париж'),
    'Начало «Жизни Арсеньева»': ('/img/places/paris-house.jpg', 'Париж'),
    'Нобелевская премия': ('/img/places/paris-house.jpg', 'Париж'),
    'Годы войны': ('/img/places/paris-house.jpg', 'Париж'),
    'Последнее публичное выступление': ('/img/places/paris-house.jpg', 'Париж'),
    'Смерть в Париже': ('/img/places/paris-grave.jpg', 'Кладбище в Париже'),
}


def square(im):
    im = ImageOps.exif_transpose(im)
    if im.mode != "RGB":
        im = im.convert("RGB")
    # верхняя треть важнее для портретов: режем от верха, а не от центра
    side = min(im.width, im.height)
    left = (im.width - side) // 2
    top = 0 if im.height > im.width else (im.height - side) // 2
    return im.crop((left, top, left + side, top + side)).resize((SIZE, SIZE), Image.Resampling.LANCZOS)


def main():
    os.makedirs(OUT, exist_ok=True)
    data = json.load(open(os.path.join(ROOT, "data", "timeline.json"), encoding="utf-8"))
    done, missing = 0, []
    for event in data:
        spec = EVENTS.get(event["title"])
        if not spec:
            continue
        src, alt = spec
        full = os.path.join(ROOT, "public", src.lstrip("/"))
        if not os.path.exists(full):
            missing.append(src)
            continue
        name = "tl-" + event["date"] + "-" + str(done + 1).zfill(2)
        jpg = os.path.join(OUT, name + ".jpg")
        webp = os.path.join(OUT, name + ".webp")
        with Image.open(full) as im:
            square(im).save(jpg, "JPEG", quality=82, optimize=True, progressive=True)
        with Image.open(jpg) as im:
            im.save(webp, "WEBP", quality=78, method=6)
        event["photo"] = "/img/thumbs/%s.jpg" % name
        event["photoWebp"] = "/img/thumbs/%s.webp" % name
        event["photoAlt"] = alt
        done += 1
    json.dump(data, open(os.path.join(ROOT, "data", "timeline.json"), "w", encoding="utf-8", newline="\n"),
              ensure_ascii=False, indent=2)
    print("миниатюр:", done, "из", len(data), "событий")
    if missing:
        print("НЕТ ФАЙЛОВ:", *missing, sep="\n  ")


if __name__ == "__main__":
    main()
