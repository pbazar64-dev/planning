// Утилиты для работы с датами и временем. Неделя начинается с понедельника.

import { GRID } from './config.js';

const WEEKDAYS_SHORT = ['ВС', 'ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ'];
const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Понедельник недели, которой принадлежит date.
export function startOfWeek(date) {
  const d = startOfDay(date);
  const day = d.getDay(); // 0=вс ... 6=сб
  const diff = (day === 0 ? -6 : 1 - day); // сдвиг до понедельника
  d.setDate(d.getDate() + diff);
  return d;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addWeeks(date, weeks) {
  return addDays(date, weeks * 7);
}

// Массив из 5 дат (ПН–ПТ) для недели, содержащей date.
export function weekDays(date) {
  const monday = startOfWeek(date);
  return Array.from({ length: GRID.daysPerWeek }, (_, i) => addDays(monday, i));
}

export function isSameDay(a, b) {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

export function isToday(date) {
  return isSameDay(date, new Date());
}

// «ПН, 15 мая»
export function formatDayLabel(date) {
  const d = new Date(date);
  return `${WEEKDAYS_SHORT[d.getDay()]}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
}

// «15 мая 2026» — для заголовков диапазона.
export function formatDateRu(date) {
  const d = new Date(date);
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
}

// «HH:MM»
export function formatTime(date) {
  const d = new Date(date);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// Дата+время в формате, который ожидают REST-методы Битрикс24:
// «YYYY-MM-DD HH:MM:SS».
export function toB24DateTime(date) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// «YYYY-MM-DD» для значений datetime-local и сравнения дней.
export function toDateInputValue(date) {
  const d = new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// «YYYY-MM-DDTHH:MM» для input[type=datetime-local].
export function toDateTimeInputValue(date) {
  return `${toDateInputValue(date)}T${formatTime(date)}`;
}

// Разбор значения Битрикс24 (ISO или «YYYY-MM-DD HH:MM:SS») в Date.
export function parseB24Date(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  // Битрикс часто отдаёт ISO со смещением — Date справляется.
  let d = new Date(value);
  if (!isNaN(d)) return d;
  // Фолбэк для «YYYY-MM-DD HH:MM:SS».
  d = new Date(String(value).replace(' ', 'T'));
  return isNaN(d) ? null : d;
}

// Сколько минут прошло от начала рабочей сетки (8:00) до date в этот день.
export function minutesFromGridStart(date) {
  const d = new Date(date);
  return (d.getHours() - GRID.workStartHour) * 60 + d.getMinutes();
}

// Секунды -> «6.5» часов (одна десятая).
export function secondsToHours(seconds) {
  const h = (Number(seconds) || 0) / 3600;
  return Math.round(h * 10) / 10;
}

// Секунды -> «Ч:ММ» (например, 4800 -> «1:20»).
export function formatHM(seconds) {
  const totalMin = Math.round((Number(seconds) || 0) / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// Дата начала и конца недели в формате Битрикс24 — для фильтров запросов.
export function weekRangeB24(date) {
  const monday = startOfWeek(date);
  const from = startOfDay(monday);
  const to = addDays(from, GRID.daysPerWeek); // включительно по ПТ 23:59
  return {
    from: toB24DateTime(from),
    to: toB24DateTime(new Date(to.getTime() - 1)),
    fromDate: from,
    toDate: new Date(to.getTime() - 1),
  };
}

export { MS_PER_DAY };
