// Правила повторения для задач, встреч и отсутствий.
//
// Правило (rule):
//   { freq: 'none'|'workdays'|'daily'|'weekly'|'monthly',
//     interval: number,          // «каждые N» дней/недель/месяцев
//     byDay: ['MO', 'WE', ...],  // дни недели для weekly
//     endMode: 'never'|'count'|'until',
//     count: number,             // сколько раз всего (вместе с первым)
//     until: Date|null }         // последний день серии (включительно)
//
// Все повторения хранятся в календаре Битрикс24 (параметр rrule события):
// встречи и отсутствия — как есть, а повторяющаяся работа над задачей —
// серией «слотов задачи» (см. js/data.js). Сама задача в Б24 остаётся одна.

import { startOfDay, startOfWeek, addDays, formatDateRu, parseB24Date } from './dates.js';

// Предел горизонта разворачивания серии — 5 лет.
const RECUR_HORIZON_DAYS = 366 * 5;
// Календарь Б24 хранит «бесконечные» серии с окончанием 01.01.2038.
const RECUR_NEVER_YEAR = 2038;

export const RECUR_FREQS = [
  ['none', 'Не повторять'],
  ['workdays', 'Каждый рабочий день (ПН–ПТ)'],
  ['daily', 'Ежедневно'],
  ['weekly', 'Еженедельно'],
  ['monthly', 'Ежемесячно'],
];

export const RECUR_END_MODES = [
  ['never', 'Без даты окончания'],
  ['count', 'После количества повторений'],
  ['until', 'В указанную дату'],
];

// Коды дней недели в порядке ПН..ВС и соответствие Date.getDay().
export const RECUR_WEEKDAYS = [
  ['MO', 'ПН'], ['TU', 'ВТ'], ['WE', 'СР'], ['TH', 'ЧТ'], ['FR', 'ПТ'], ['SA', 'СБ'], ['SU', 'ВС'],
];
const RECUR_DAY_BY_JS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const RECUR_WORKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR'];

export function weekdayCode(date) {
  return RECUR_DAY_BY_JS[new Date(date).getDay()];
}

export function isRecurring(rule) {
  return !!rule && !!rule.freq && rule.freq !== 'none';
}

// Проверка правила перед сохранением. Бросает Error с понятным текстом.
export function validateRule(rule, start) {
  if (!isRecurring(rule)) return;
  if (!(rule.interval >= 1)) throw new Error('Интервал повторения должен быть не меньше 1');
  if (rule.freq === 'weekly' && (!rule.byDay || rule.byDay.length === 0)) {
    throw new Error('Выберите хотя бы один день недели для повторения');
  }
  if (rule.endMode === 'count') {
    if (!(rule.count >= 2)) throw new Error('Количество повторений должно быть не меньше 2');
  } else if (rule.endMode === 'until') {
    if (!rule.until || isNaN(rule.until)) throw new Error('Укажите дату окончания повторений');
    if (startOfDay(rule.until) < startOfDay(start)) {
      throw new Error('Дата окончания повторений раньше начала');
    }
  }
}

// Параметр rrule для calendar.event.add / calendar.event.update.
export function toB24RRule(rule) {
  if (!isRecurring(rule)) return null;
  const r = { INTERVAL: rule.interval || 1 };
  switch (rule.freq) {
    case 'workdays':
      r.FREQ = 'WEEKLY';
      r.INTERVAL = 1;
      r.BYDAY = [...RECUR_WORKDAYS];
      break;
    case 'daily': r.FREQ = 'DAILY'; break;
    case 'weekly': r.FREQ = 'WEEKLY'; r.BYDAY = [...rule.byDay]; break;
    case 'monthly': r.FREQ = 'MONTHLY'; break;
    default: return null;
  }
  if (rule.endMode === 'count') r.COUNT = rule.count;
  else if (rule.endMode === 'until') r.UNTIL = formatRuDate(rule.until);
  return r;
}

// «DD.MM.YYYY» — формат даты, который понимает календарь Б24.
function formatRuDate(date) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// Разбор rrule из календаря Б24 (строка «FREQ=WEEKLY;BYDAY=MO,WE» или объект)
// в правило формы. Неподдерживаемые правила (ежегодно и т.п.) — null.
export function parseB24RRule(rr) {
  if (!rr) return null;
  const obj = typeof rr === 'string' ? parseRRuleString(rr) : rr;
  if (!obj || typeof obj !== 'object') return null;
  const freq = String(obj.FREQ || '').toUpperCase();
  if (!freq || freq === 'NONE') return null;

  const interval = Number(obj.INTERVAL) || 1;
  const byDay = normalizeByDay(obj.BYDAY);
  const rule = { freq: '', interval, byDay, endMode: 'never', count: 0, until: null };

  if (freq === 'DAILY') rule.freq = 'daily';
  else if (freq === 'WEEKLY') {
    const isWorkdays = interval === 1 && byDay.length === 5 && RECUR_WORKDAYS.every((d) => byDay.includes(d));
    rule.freq = isWorkdays ? 'workdays' : 'weekly';
  } else if (freq === 'MONTHLY') rule.freq = 'monthly';
  else return null;

  const count = Number(obj.COUNT);
  if (count > 0) {
    rule.endMode = 'count';
    rule.count = count;
  } else if (obj.UNTIL) {
    const until = parseUntil(obj.UNTIL);
    if (until && until.getFullYear() < RECUR_NEVER_YEAR) {
      rule.endMode = 'until';
      rule.until = until;
    }
  }
  return rule;
}

function normalizeByDay(v) {
  if (!v) return [];
  let arr = v;
  if (!Array.isArray(arr)) arr = typeof arr === 'object' ? Object.values(arr) : String(arr).split(',');
  return arr.map((d) => String(d).trim().toUpperCase().slice(-2)).filter((d) => RECUR_DAY_BY_JS.includes(d));
}

// UNTIL встречается как «DD.MM.YYYY», «YYYY-MM-DD», «YYYYMMDD[T…]» или timestamp.
function parseUntil(v) {
  if (typeof v === 'number' || /^\d{9,}$/.test(String(v))) return new Date(Number(v) * 1000);
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(String(v));
  if (compact && !String(v).includes('-')) return new Date(+compact[1], +compact[2] - 1, +compact[3]);
  const d = parseB24Date(v);
  return d ? startOfDay(d) : null;
}

// «FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE» -> { FREQ, INTERVAL, BYDAY: [...] }
function parseRRuleString(str) {
  const out = {};
  for (const part of String(str).split(';')) {
    const [k, v] = part.split('=');
    if (!k || v == null) continue;
    const key = k.trim().toUpperCase();
    out[key] = key === 'BYDAY' ? v.split(',') : v;
  }
  return out;
}

// Разворачивает серию, начинающуюся с start–end, в вхождения { start, end },
// попадающие в окно [from, to). Без окна — все вхождения (с ограничением limit).
export function expandOccurrences(rule, start, end, { from = null, to = null, limit = 1000 } = {}) {
  const duration = end - start;
  const inWindow = (s, e) => (!from || e > from) && (!to || s < to);
  if (!isRecurring(rule)) {
    return inWindow(start, end) ? [{ start: new Date(start), end: new Date(end) }] : [];
  }

  const first = startOfDay(start);
  const firstWeek = startOfWeek(start);
  const until = rule.endMode === 'until' && rule.until ? startOfDay(rule.until) : null;
  const maxCount = rule.endMode === 'count' ? rule.count : Infinity;
  const interval = rule.interval || 1;

  const out = [];
  let n = 0;
  for (let i = 0; i <= RECUR_HORIZON_DAYS && n < maxCount && out.length < limit; i++) {
    const day = addDays(first, i);
    if (until && day > until) break;
    if (to && day >= to) break;
    if (!matchesDay(rule, interval, day, first, firstWeek)) continue;
    n++;
    const s = new Date(day);
    s.setHours(start.getHours(), start.getMinutes(), 0, 0);
    const e = new Date(s.getTime() + duration);
    if (inWindow(s, e)) out.push({ start: s, end: e });
  }
  return out;
}

function matchesDay(rule, interval, day, first, firstWeek) {
  const dow = day.getDay();
  switch (rule.freq) {
    case 'workdays':
      return dow >= 1 && dow <= 5;
    case 'daily':
      return diffDays(first, day) % interval === 0;
    case 'weekly': {
      if (!rule.byDay.includes(RECUR_DAY_BY_JS[dow])) return false;
      const weeks = Math.floor(diffDays(firstWeek, startOfWeek(day)) / 7);
      return weeks % interval === 0;
    }
    case 'monthly': {
      if (day.getDate() !== first.getDate()) return false;
      const months = (day.getFullYear() - first.getFullYear()) * 12 + day.getMonth() - first.getMonth();
      return months % interval === 0;
    }
    default:
      return false;
  }
}

// Разница в календарных днях (устойчива к переходу на летнее время).
function diffDays(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / (24 * 60 * 60 * 1000));
}

// Человекочитаемое описание: «Еженедельно по ПН, СР, 10 раз».
export function describeRule(rule) {
  if (!isRecurring(rule)) return 'Не повторяется';
  const n = rule.interval || 1;
  let s;
  switch (rule.freq) {
    case 'workdays': s = 'каждый рабочий день'; break;
    case 'daily': s = n > 1 ? `каждые ${n} дн.` : 'ежедневно'; break;
    case 'weekly': {
      const days = RECUR_WEEKDAYS.filter(([c]) => rule.byDay.includes(c)).map(([, l]) => l).join(', ');
      s = (n > 1 ? `каждые ${n} нед.` : 'еженедельно') + ` по ${days}`;
      break;
    }
    case 'monthly': s = n > 1 ? `каждые ${n} мес.` : 'ежемесячно'; break;
    default: s = '';
  }
  if (rule.endMode === 'count') s += `, ${rule.count} раз`;
  else if (rule.endMode === 'until' && rule.until) s += `, до ${formatDateRu(rule.until)}`;
  else s += ', без даты окончания';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Описание rrule из календаря Б24 для тултипа.
export function describeB24RRule(rr) {
  const rule = parseB24RRule(rr);
  return rule ? describeRule(rule) : 'Повторяется';
}
