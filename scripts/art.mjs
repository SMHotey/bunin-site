// Пути к рисункам-водяным знакам для карточек. Файлы создаёт scripts/make-card-art.py.
// Общий модуль: нужен и генератору страниц (scripts/build.mjs), и разделу sections.mjs,
// чтобы у карточек одного типа рисунок был одинаковым.

const GENRE_ART = {
  'Стихотворение': 'stihotvorenie',
  'Поэма': 'poema',
  'Рассказ': 'proza',
  'Повесть': 'proza',
  'Роман': 'proza',
  'Проза': 'proza',
  'Статья': 'statya',
  'Очерк': 'statya',
  'Дневник': 'avtobiografiya',
  'Автобиография': 'avtobiografiya',
  'Мемуары': 'avtobiografiya',
};
export const genreArt = (genre) => `/img/genre/${GENRE_ART[genre] || 'default'}.svg`;

const MUSIC_ART = {
  'романс': 'romance',
  'романсы': 'romance',
  'вокальный цикл': 'score',
  'хор': 'chorus',
  'вокальная композиция': 'song',
  'песня': 'song',
};
export const musicArt = (kind) => `/img/art/${MUSIC_ART[String(kind || '').toLowerCase()] || 'song'}.svg`;

const FILM_ART = {
  'игровой фильм': 'film',
  'телефильм': 'serial',
  'телесериал': 'serial',
  'фильм-спектакль': 'film',
  'документальное кино': 'documentary',
  'документальный фильм': 'documentary',
};
export const filmArt = (kind) => `/img/art/${FILM_ART[String(kind || '').toLowerCase()] || 'film'}.svg`;

export function researchArt(type) {
  const t = String(type || '');
  if (/Сборник|Антология|Собрание сочинений|Биографические материалы|Материалы/i.test(t)) return '/img/art/collection.svg';
  if (/Монография|биография|исследование|ЖЗЛ|Роман-хроника|Переписка/i.test(t)) return '/img/art/monograph.svg';
  if (/статья|хроника|Летопись/i.test(t)) return '/img/art/article.svg';
  return '/img/art/thesis.svg';
}

// Категории людей: у кого нет портрета в свободных источниках — гравированный медальон.
const PEOPLE_ART = { family: 'family', relatives: 'relatives', friends: 'friends', wives: 'wives', women: 'women', children: 'children' };
export const personArt = (p) => `/img/people/art-${PEOPLE_ART[p.category] || 'friends'}.svg`;

// Подборки: у каждой свой рисунок (scripts/make-card-art.py → public/img/topics/<id>.svg).
export const topicArt = (id) => `/img/topics/${id}.svg`;
