# -*- coding: utf-8 -*-
"""Корпусные расчёты по библиотеке Бунина (data/works.json).

Правила из скилла author-site-content-depth:
- стихотворения считаем отдельно от прозы и поэм: иначе средняя длина и частоты врут;
- частоты — на 10 000 словоупотреблений, а не абсолютные числа;
- словоформы, а не леммы: это оговаривается в статье;
- результат: reports/corpus-bunin.json (в .gitignore — артефакт, а не данные).
"""
import json
import os
import re
from collections import Counter

works = json.load(open('data/works.json', encoding='utf-8'))
TOKEN = re.compile(r'[а-яё]+', re.I)

STOP = set("""и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по
только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или
ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где
есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда
кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас
были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через
эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда
лучше чуть том нельзя такой им более всегда конечно всю между это среди очень точно весь вся
все одна однако снова стал стала стали теперь просто кажется помню знаю вижу думаю говорю
сказал сказала сказали ответил ответила спросил спросила""".split())


def norm_year(w):
    try:
        y = int(w.get('year'))
    except (TypeError, ValueError):
        return None
    return y if 1870 <= y <= 1953 else None


poems = [w for w in works if (w.get('genre') or '').lower() == 'стихотворение']
prose = [w for w in works if (w.get('genre') or '').lower() != 'стихотворение']


def tokens(text):
    return [t.lower().replace('ё', 'е') for t in TOKEN.findall(text or '')]


def stats(items, name):
    words = sum(len(tokens(w.get('text'))) for w in items)
    uniq = set()
    for w in items:
        uniq.update(tokens(w.get('text')))
    lengths = sorted(len(tokens(w.get('text'))) for w in items)
    n = len(items) or 1
    return {
        'name': name,
        'works': len(items),
        'tokens': words,
        'vocab': len(uniq),
        'avgTokens': round(words / n, 1),
        'medianTokens': lengths[len(lengths) // 2] if lengths else 0,
        'minTokens': lengths[0] if lengths else 0,
        'maxTokens': lengths[-1] if lengths else 0,
    }


summary = [stats(works, 'вся библиотека'), stats(poems, 'стихотворения'), stats(prose, 'проза и поэмы')]

line_lengths = []
for w in poems:
    for line in (w.get('text') or '').split('\n'):
        s = line.strip()
        if not s or s.startswith(('#', '==', '---', '*', '>')):
            continue
        if s.startswith('(') and s.endswith(')'):
            continue
        n = len(tokens(s))
        if n:
            line_lengths.append(n)
line_lengths.sort()
line_stats = {
    'lines': len(line_lengths),
    'avgWords': round(sum(line_lengths) / len(line_lengths), 2),
    'medianWords': line_lengths[len(line_lengths) // 2],
    'p90': line_lengths[int(len(line_lengths) * 0.9)],
    'share4to6': round(100 * sum(1 for x in line_lengths if 4 <= x <= 6) / len(line_lengths), 1),
}

years_all = [y for y in (norm_year(w) for w in works) if y]
early = [w for w in works if norm_year(w) and norm_year(w) <= 1910]
late = [w for w in works if norm_year(w) and norm_year(w) >= 1911]
poems_early = [w for w in poems if norm_year(w) and norm_year(w) <= 1910]
poems_late = [w for w in poems if norm_year(w) and norm_year(w) >= 1911]


def freq(items):
    c = Counter()
    for w in items:
        c.update(tokens(w.get('text')))
    return c


f_all, f_poems, f_prose = freq(works), freq(poems), freq(prose)
f_early, f_late = freq(poems_early), freq(poems_late)
t_all, t_poems, t_prose = sum(f_all.values()), sum(f_poems.values()), sum(f_prose.values())
t_early, t_late = sum(f_early.values()), sum(f_late.values())


def per10k(counter, total, word):
    return round(counter[word] * 10000 / (total or 1), 1)


def top_words(counter, total, limit=30):
    rows = []
    for word, n in counter.most_common(600):
        if word in STOP or len(word) < 3:
            continue
        rows.append({'word': word, 'count': n, 'per10k': per10k(counter, total, word)})
        if len(rows) >= limit:
            break
    return rows


top_poems = top_words(f_poems, t_poems, 30)
top_prose = top_words(f_prose, t_prose, 20)

growth = []
for word, n in f_poems.items():
    if word in STOP or len(word) < 4 or n < 12:
        continue
    a, b = per10k(f_early, t_early, word), per10k(f_late, t_late, word)
    if a >= 1 or b >= 1:
        growth.append({'word': word, 'early': a, 'late': b, 'delta': round(b - a, 1)})
growth.sort(key=lambda x: x['delta'])

hapax = sorted(w for w, n in f_poems.items() if n == 1)
by_decade = Counter((y // 10) * 10 for y in years_all)
decade_rows = []
for dec in sorted(by_decade):
    ps = [w for w in poems if norm_year(w) and (norm_year(w) // 10) * 10 == dec]
    words = sum(len(tokens(w.get('text'))) for w in ps)
    decade_rows.append({
        'decade': f'{dec}-е',
        'works': by_decade[dec],
        'poems': len(ps),
        'avgTokens': round(words / len(ps), 1) if ps else 0,
    })

report = {
    'summary': summary,
    'lines': line_stats,
    'periods': {
        'early': {'years': '1886—1910', 'works': len(early), 'poems': len(poems_early), 'tokens': t_early},
        'late': {'years': '1911—1938', 'works': len(late), 'poems': len(poems_late), 'tokens': t_late},
    },
    'topPoems': top_poems,
    'topProse': top_prose,
    'growth': growth[-20:],
    'decline': growth[:20],
    'hapax': {'count': len(hapax), 'sample': hapax[:40]},
    'decades': decade_rows,
    'yearsCovered': {'withYear': len(years_all), 'total': len(works), 'min': min(years_all), 'max': max(years_all)},
}

os.makedirs('reports', exist_ok=True)
json.dump(report, open('reports/corpus-bunin.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

print('=== ОБЪЁМ')
for s in summary:
    print(f"  {s['name']}: {s['works']} текстов, {s['tokens']} словоупотреблений, словарь {s['vocab']}, "
          f"средняя длина {s['avgTokens']}, медиана {s['medianTokens']}")
print(f"  годы известны у {len(years_all)} из {len(works)}; диапазон {min(years_all)}—{max(years_all)}")
print('=== ЛИРИКА: ДО/ПОСЛЕ 1910')
print(f"  до 1910: {len(poems_early)} стих., {t_early} словоупотреблений")
print(f"  с 1911:  {len(poems_late)} стих., {t_late} словоупотреблений")
print('=== СТИХОТВОРНАЯ СТРОКА')
print(' ', line_stats)
print('=== ТОП ЛИРИКИ (на 10 000)')
for r in top_poems[:25]:
    print(f"  {r['word']:14s} {r['per10k']:6.1f}")
print('=== ТОП ПРОЗЫ (на 10 000)')
for r in top_prose[:12]:
    print(f"  {r['word']:14s} {r['per10k']:6.1f}")
print('=== РОСТ В ЛИРИКЕ (с 1911)')
for g in growth[-10:]:
    print(f"  {g['word']:14s} {g['early']:5.1f} → {g['late']:5.1f}")
print('=== ПАДЕНИЕ В ЛИРИКЕ')
for g in growth[:10]:
    print(f"  {g['word']:14s} {g['early']:5.1f} → {g['late']:5.1f}")
print('=== ГАПАКС ЛИРИКИ')
print(' ', len(hapax), ':', ', '.join(hapax[:20]))
print('=== ПО ДЕСЯТИЛЕТИЯМ (стихотворения)')
for d in decade_rows:
    print(f"  {d['decade']}: текстов всего {d['works']}, стих. {d['poems']}, средняя длина {d['avgTokens']}")
