// Единый тултип с полной информацией о ячейке, следующий за курсором.

import { formatTime } from '../dates.js';

let tip;

function ensure() {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'tooltip';
    document.body.appendChild(tip);
  }
  return tip;
}

function buildHtml(item) {
  const rows = [];
  rows.push(`<div class="tooltip__title">${escapeHtml(item.title)}</div>`);

  const kindLabel = { task: 'Задача', event: 'Встреча/событие', absence: 'Отсутствие' }[item.kind];
  rows.push(`<div class="tooltip__row"><b>Тип:</b> ${kindLabel}</div>`);

  const timeStr = item.allDay
    ? 'весь день'
    : `${formatTime(item.start)}–${formatTime(item.end)}`;
  rows.push(`<div class="tooltip__row"><b>Время:</b> ${timeStr}</div>`);

  if (item.kind === 'task') {
    rows.push(`<div class="tooltip__row"><b>Часы:</b> ` +
      `план ${item.hoursPlan}, факт ${item.hoursFact}, сегодня ${item.hoursToday}</div>`);
    if (item.status) {
      rows.push(`<div class="tooltip__row"><b>Статус:</b> ${item.status.icon} ${item.status.label}</div>`);
    }
  }
  if (item.description) {
    rows.push(`<div class="tooltip__row tooltip__desc">${escapeHtml(stripHtml(item.description)).slice(0, 280)}</div>`);
  }
  return rows.join('');
}

export function showTooltip(item, x, y) {
  const el = ensure();
  el.innerHTML = buildHtml(item);
  el.classList.add('tooltip--visible');
  moveTooltip(x, y);
}

export function moveTooltip(x, y) {
  if (!tip) return;
  const pad = 14;
  const rect = tip.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight) top = y - rect.height - pad;
  tip.style.left = Math.max(4, left) + 'px';
  tip.style.top = Math.max(4, top) + 'px';
}

export function hideTooltip() {
  if (tip) tip.classList.remove('tooltip--visible');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function stripHtml(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
