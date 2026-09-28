// Правила повторения для задач, встреч и отсутствий.
//
// Правило (rule):
//   { freq: 'none'|'workdays'|'daily'|'weekly'|'monthly',
//     interval: number,          // «каждые N» дней/недель/месяцев
//     byDay: ['MO', 'WE', ...],  // дни недели для weekly
//     endMode: 'count'|'until',
//     count: number,             // сколько раз всего (вместе с первым)
//     until: Date|null }         // последний день серии (включительно)
//
// Встречи и отсутствия повторяются средствами календаря Битрикс24 (rrule),
// задачи — создаются отдельной задачей на каждое повторение.

import { startOfDay, startOfWeek, addDays, toDateInputValue, formatDateRu } from './dates.js';

// Предел числа повторений для задач (каждая — отдельный tasks.task.add).
export const RECUR_MAX_TASKS = 100;
// Предел горизонта разворачивания серии — 3 года.
const RECUR_HORIZON_DAYS = 366 * 3;

export const RECUR_FREQS = [
  ['none', 'Не повторять'],
  ['workdays', 'Каждый рабочий день (ПН–ПТ)'],
  ['daily', 'Ежедневно'],
  ['weekly', 'Еженедельно'],
  ['monthly', 'Ежемесячно'],
];

// Коды дней недели в порядке ПН..ВС и соответствие Date.getDay().
export const RECUR_WEEKDAYS = [
  ['MO', 'ПН'], ['TU', 'ВТ'], ['WE', 'СР'], ['TH', 'ЧТ'], ['FR', 'ПТ'], ['SA', 'СБ'], ['SU', 'ВС'],
];
const RECUR_DAY_BY_JS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function weekdayCode(date) {
  return RECUR_DAY_BY_JS[new Date(date).getDay()];
}

export function isRecurring(rule) {
  return !!rule && rule.freq && rule.freq !== 'none';
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
  } else {
    if (!rule.until || isNaN(rule.until)) throw new Error('Укажите дату окончания повторений');
    if (startOfDay(rule.until) < startOfDay(start)) {
      throw new Error('Дата окончания повторений раньше начала');
    }
  }
}

// Параметр rrule для calendar.event.add.
export function toB24RRule(rule) {
  const r = { INTERVAL: rule.interval || 1 };
  switch (rule.freq) {
    case 'workdays':
      r.FREQ = 'WEEKLY';
      r.INTERVAL = 1;
      r.BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR'];
      break;
    case 'daily': r.FREQ = 'DAILY'; break;
    case 'weekly': r.FREQ = 'WEEKLY'; r.BYDAY = [...rule.byDay]; break;
    case 'monthly': r.FREQ = 'MONTHLY'; break;
    default: return null;
  }
  if (rule.endMode === 'count') r.COUNT = rule.count;
  else r.UNTIL = toDateInputValue(rule.until);
  return r;
}

// Разворачивает серию в список интервалов { start, end } (первый — исходный).
// limit — предел количества (для задач).
export function expandOccurrences(rule, start, end, limit = RECUR_MAX_TASKS) {
  const duration = end - start;
  if (!isRecurring(rule)) return [{ start: new Date(start), end: new Date(end) }];

  const first = startOfDay(start);
  const firstWeek = startOfWeek(start);
  const until = rule.endMode === 'until' ? startOfDay(rule.until) : null;
  const maxCount = rule.endMode === 'count' ? Math.min(rule.count, limit) : limit;
  const interval = rule.interval || 1;

  const out = [];
  for (let i = 0; i <= RECUR_HORIZON_DAYS && out.length < maxCount; i++) {
    const day = addDays(first, i);
    if (until && day > until) break;
    if (!matchesDay(rule, interval, day, first, firstWeek)) continue;
    const s = new Date(day);
    s.setHours(start.getHours(), start.getMinutes(), 0, 0);
    out.push({ start: s, end: new Date(s.getTime() + duration) });
  }
  return out;
}

// Сколько повторений даст правило без учёта предела (для подсказки).
export function countOccurrences(rule, start, end) {
  return expandOccurrences(rule, start, end, Infinity).length;
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

// Человекочитаемое описание: «еженедельно по ПН, СР, 10 раз».
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
  s += rule.endMode === 'count' ? `, ${rule.count} раз` : `, до ${formatDateRu(rule.until)}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Описание rrule, пришедшего из календаря Битрикс24 (строка или объект).
export function describeB24RRule(rr) {
  if (!rr) return '';
  const obj = typeof rr === 'string' ? parseRRuleString(rr) : rr;
  const freq = String(obj.FREQ || '').toUpperCase();
  const n = Number(obj.INTERVAL) || 1;
  const labels = {
    DAILY: n > 1 ? `каждые ${n} дн.` : 'ежедневно',
    WEEKLY: n > 1 ? `каждые ${n} нед.` : 'еженедельно',
    MONTHLY: n > 1 ? `каждые ${n} мес.` : 'ежемесячно',
    YEARLY: n > 1 ? `каждые ${n} г.` : 'ежегодно',
  };
  let s = labels[freq] || 'повторяется';
  let byDay = obj.BYDAY;
  if (byDay && !Array.isArray(byDay)) byDay = typeof byDay === 'object' ? Object.values(byDay) : String(byDay).split(',');
  if (freq === 'WEEKLY' && byDay && byDay.length) {
    const days = RECUR_WEEKDAYS.filter(([c]) => byDay.includes(c)).map(([, l]) => l).join(', ');
    if (days) s += ` по ${days}`;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// «FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE» -> { FREQ, INTERVAL, BYDAY: [...] }
function parseRRuleString(str) {
  const out = {};
  for (const part of String(str).split(';')) {
    const [k, v] = part.split('=');
    if (!k || v == null) continue;
    out[k.trim().toUpperCase()] = k.trim().toUpperCase() === 'BYDAY' ? v.split(',') : v;
  }
  return out;
}
