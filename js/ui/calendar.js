// Рендер недельной сетки календаря: дни ПН–ПТ, временная шкала 8:00–18:00,
// шаг 30 минут, многоколоночная разбивка по сотрудникам.

import { GRID, COLORS } from '../config.js';
import {
  state, selectedUsers, itemsFor,
} from '../state.js';
import {
  weekDays, formatDayLabel, isToday, formatTime, formatHM,
  startOfDay, addDays, minutesFromGridStart,
} from '../dates.js';
import { showTooltip, moveTooltip, hideTooltip } from './tooltip.js';
import { openSlotMenu, openEditModal } from './modals.js';
import { updatePlacement, updateEvent, removePlacement, deleteEvent, deleteTask } from '../data.js';
import { bus } from '../bus.js';
import { showError } from './toast.js';

const SLOTS_PER_DAY = (GRID.workEndHour - GRID.workStartHour) * (60 / GRID.slotMinutes); // 20
const BODY_HEIGHT = SLOTS_PER_DAY * GRID.slotHeightPx; // 1000px

export function renderCalendar(root) {
  root.innerHTML = '';

  const users = selectedUsers();
  if (users.length === 0) {
    root.appendChild(emptyHint());
    return;
  }

  const days = weekDays(state.currentWeek);

  const scrollY = el('div', 'cal-scroll-y');
  const grid = el('div', 'cal-grid');
  grid.appendChild(buildTimeColumn());
  for (const day of days) {
    grid.appendChild(buildDayColumn(day, users));
  }
  scrollY.appendChild(grid);
  root.appendChild(scrollY);
}

function emptyHint() {
  const box = el('div', 'cal-empty');
  box.innerHTML =
    '<div class="cal-empty__icon">📅</div>' +
    '<div class="cal-empty__text">Выберите сотрудников для отображения</div>' +
    '<div class="cal-empty__hint">До 5 сотрудников — через список в шапке или настройки (⚙).</div>';
  return box;
}

// --- Колонка временной шкалы ----------------------------------------------

function buildTimeColumn() {
  const col = el('div', 'cal-time');
  const header = el('div', 'cal-time__header');
  col.appendChild(header);

  const body = el('div', 'cal-time__body');
  body.style.height = BODY_HEIGHT + 'px';
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const label = el('div', 'cal-time__slot');
    label.style.height = GRID.slotHeightPx + 'px';
    const minutes = i * GRID.slotMinutes;
    if (minutes % 60 === 0) {
      const hour = GRID.workStartHour + minutes / 60;
      label.textContent = String(hour).padStart(2, '0') + ':00';
      label.classList.add('cal-time__slot--hour');
    }
    body.appendChild(label);
  }
  col.appendChild(body);
  return col;
}

// --- Колонка дня ----------------------------------------------------------

function buildDayColumn(day, users) {
  const col = el('div', 'cal-day');
  if (isToday(day)) col.classList.add('cal-day--today');

  const header = el('div', 'cal-day__header');
  header.textContent = formatDayLabel(day);
  col.appendChild(header);

  // Минимальная ширина подколонки сотрудника. При 3+ сотрудниках появляется
  // горизонтальный скролл всей сетки (за счёт суммарной ширины).
  const subWidth = users.length >= 3 ? 140 : 0;

  const subHeader = el('div', 'cal-day__sub');
  for (const u of users) {
    const cell = el('div', 'cal-day__sub-cell');
    if (subWidth) cell.style.minWidth = subWidth + 'px';
    cell.title = u.name + (u.position ? ' — ' + u.position : '');
    cell.textContent = shortName(u.name);
    subHeader.appendChild(cell);
  }
  col.appendChild(subHeader);

  const body = el('div', 'cal-day__body');
  for (const u of users) {
    body.appendChild(buildSubColumn(day, u, subWidth));
  }
  col.appendChild(body);
  return col;
}

function buildSubColumn(day, user, minColWidth) {
  const sub = el('div', 'cal-subcol');
  sub.style.height = BODY_HEIGHT + 'px';
  if (minColWidth) sub.style.minWidth = minColWidth + 'px';

  // Фоновые 30-минутные слоты (кликабельны для создания).
  for (let i = 0; i < SLOTS_PER_DAY; i++) {
    const slot = el('div', 'cal-slot');
    slot.style.height = GRID.slotHeightPx + 'px';
    if (i % 2 === 1) slot.classList.add('cal-slot--half');
    slot.addEventListener('click', () => {
      const start = slotTime(day, i);
      const end = slotTime(day, i + 1);
      openSlotMenu({ user, start, end });
    });
    sub.appendChild(slot);
  }

  // Блоки сущностей поверх слотов.
  const items = itemsFor(user.id);
  const dayItems = items
    .map((it) => geometryFor(it, day))
    .filter(Boolean);
  layoutLanes(dayItems);
  for (const g of dayItems) {
    sub.appendChild(buildBlock(g, day));
  }
  return sub;
}

// --- Геометрия блока на сетке дня ------------------------------------------

function geometryFor(item, day) {
  const dayStart = startOfDay(day);
  const nextDay = addDays(dayStart, 1);
  // Пересекает ли этот день вообще?
  if (item.end <= dayStart || item.start >= nextDay) return null;

  const gridTop = new Date(dayStart); gridTop.setHours(GRID.workStartHour, 0, 0, 0);
  const gridBottom = new Date(dayStart); gridBottom.setHours(GRID.workEndHour, 0, 0, 0);

  const continuesBefore = item.start < gridTop;
  const continuesAfter = item.end > gridBottom;

  let clampStart = item.start < gridTop ? gridTop : item.start;
  let clampEnd = item.end > gridBottom ? gridBottom : item.end;

  let top, height, outOfGrid = false;
  if (item.allDay) {
    top = 0; height = BODY_HEIGHT;
  } else if (clampEnd <= clampStart) {
    // Полностью вне рабочих часов, но внутри дня — прижимаем к краю.
    outOfGrid = true;
    if (item.end <= gridTop) { top = 0; height = 18; }
    else { top = BODY_HEIGHT - 18; height = 18; }
  } else {
    top = (minutesFromGridStart(clampStart) / GRID.slotMinutes) * GRID.slotHeightPx;
    const endMin = (clampEnd - gridTop) / 60000;
    height = (endMin / GRID.slotMinutes) * GRID.slotHeightPx - top;
    height = Math.max(height, 22); // минимально видимая высота
  }

  return {
    item, top, height,
    continuesBefore, continuesAfter, outOfGrid,
    lane: 0, lanes: 1,
  };
}

// Простейшая раскладка пересекающихся блоков по «дорожкам».
function layoutLanes(geoms) {
  const sorted = [...geoms].sort((a, b) => a.top - b.top || a.item.start - b.item.start);
  const active = []; // {endPx, lane}
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const lanes = Math.max(1, new Set(cluster.map((g) => g.lane)).size);
    for (const g of cluster) g.lanes = lanes;
    cluster = [];
  };

  for (const g of sorted) {
    if (g.top >= clusterEnd) { flush(); active.length = 0; }
    // найти свободную дорожку
    let lane = 0;
    while (active.some((a) => a.lane === lane && a.endPx > g.top)) lane++;
    g.lane = lane;
    active.push({ lane, endPx: g.top + g.height });
    clusterEnd = Math.max(clusterEnd, g.top + g.height);
    cluster.push(g);
  }
  flush();
}

// --- DOM блока ------------------------------------------------------------

function buildBlock(g, day) {
  const { item } = g;
  const block = el('div', `cal-block cal-block--${item.kind}`);
  const colors = COLORS[item.kind];
  block.style.top = g.top + 'px';
  block.style.height = g.height + 'px';
  block.style.left = `calc(${(g.lane / g.lanes) * 100}% + 2px)`;
  block.style.width = `calc(${100 / g.lanes}% - 4px)`;
  block.style.background = colors.bg;
  block.style.borderColor = colors.border;
  if (g.outOfGrid) block.classList.add('cal-block--edge');

  // Маркеры выхода за пределы сетки (для событий с конкретным временем).
  if (!item.allDay && g.continuesBefore) block.appendChild(edgeMark('top', '↑ до сетки'));
  if (!item.allDay && g.continuesAfter) block.appendChild(edgeMark('bottom', '↓ за сеткой'));

  const content = el('div', 'cal-block__content');
  const title = el('div', 'cal-block__title');
  title.textContent = item.title;
  content.appendChild(title);

  if (item.kind === 'task' || item.kind === 'placement') {
    const meta = el('div', 'cal-block__meta');
    const statusHtml = item.status
      ? `<span class="cal-block__status" title="${item.status.label}">${item.status.icon}</span>`
      : '';
    meta.innerHTML = statusHtml +
      `<span class="cal-block__hours">ф:${formatHM(item.secFact)}/п:${formatHM(item.secPlan)}/с:${formatHM(item.secToday)}</span>`;
    content.appendChild(meta);
  } else {
    const meta = el('div', 'cal-block__meta');
    meta.textContent = item.allDay ? 'весь день' : `${formatTime(item.start)}–${formatTime(item.end)}`;
    content.appendChild(meta);
  }
  block.appendChild(content);

  // Карандаш редактирования при наведении.
  const pencil = el('button', 'cal-block__edit');
  pencil.textContent = '✎';
  pencil.title = 'Редактировать';
  pencil.addEventListener('click', (e) => { e.stopPropagation(); openEditModal(item); });
  block.appendChild(pencil);

  // Корзина — удалить ячейку.
  const trash = el('button', 'cal-block__del');
  trash.textContent = '🗑';
  trash.title = 'Удалить';
  trash.addEventListener('click', (e) => { e.stopPropagation(); deleteBlock(item); });
  block.appendChild(trash);

  // Ручки изменения длительности по краям — для планируемых задач и событий.
  // Тянем границу мышью, попап редактирования при этом не открывается.
  const resizable = !item.allDay && !g.outOfGrid &&
    (item.kind === 'placement' || item.kind === 'event' || item.kind === 'absence');
  if (resizable) {
    block.appendChild(buildResizeHandle('top', g, day, item, block));
    block.appendChild(buildResizeHandle('bottom', g, day, item, block));
  }

  // Взаимодействие.
  block.addEventListener('dblclick', (e) => { e.stopPropagation(); openEditModal(item); });
  block.addEventListener('mouseenter', (e) => showTooltip(item, e.clientX, e.clientY));
  block.addEventListener('mousemove', (e) => moveTooltip(e.clientX, e.clientY));
  block.addEventListener('mouseleave', hideTooltip);

  return block;
}

async function deleteBlock(item) {
  hideTooltip();
  try {
    if (item.kind === 'placement') {
      await removePlacement(item.localId);
    } else if (item.kind === 'event' || item.kind === 'absence') {
      if (!window.confirm('Удалить это событие из Битрикс24?')) return;
      await deleteEvent(item.rawId, item.userId);
    } else if (item.kind === 'task') {
      if (!window.confirm(`Удалить задачу «${item.title}» в Битрикс24? Действие необратимо.`)) return;
      await deleteTask(item.rawId);
    }
    await bus.reloadWeek();
  } catch (e) {
    showError(e);
  }
}

// --- Изменение длительности перетаскиванием края ---------------------------

function buildResizeHandle(edge, g, day, item, block) {
  const handle = el('div', `cal-block__resize cal-block__resize--${edge}`);
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideTooltip();
    startResize(edge, g, day, item, block, e.clientY);
  });
  // Гасим клики/двойные клики на ручке, чтобы не открыть попап.
  handle.addEventListener('click', (e) => e.stopPropagation());
  handle.addEventListener('dblclick', (e) => e.stopPropagation());
  return handle;
}

function startResize(edge, g, day, item, block, startY) {
  const origTop = g.top;
  const origHeight = g.height;
  const minPx = GRID.slotHeightPx; // минимум 30 минут
  let curTop = origTop;
  let curHeight = origHeight;

  const onMove = (ev) => {
    const dy = ev.clientY - startY;
    if (edge === 'top') {
      let top = origTop + dy;
      top = Math.max(0, Math.min(top, origTop + origHeight - minPx));
      curTop = top;
      curHeight = origTop + origHeight - top;
    } else {
      let height = origHeight + dy;
      height = Math.max(minPx, Math.min(height, BODY_HEIGHT - origTop));
      curHeight = height;
    }
    block.style.top = curTop + 'px';
    block.style.height = curHeight + 'px';
  };

  const onUp = async () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.classList.remove('is-resizing');

    // Привязка к 30-минутной сетке.
    const snap = (px) => Math.round(px / GRID.slotHeightPx) * GRID.slotHeightPx;
    let top = snap(curTop);
    let height = Math.max(GRID.slotHeightPx, snap(curHeight));
    if (top + height > BODY_HEIGHT) height = BODY_HEIGHT - top;

    const { start, end } = pxToTimes(day, top, height);
    if (!(end > start)) { bus.reloadWeek(); return; }
    try {
      if (item.kind === 'placement') {
        await updatePlacement(item.localId, { start, end });
      } else {
        await updateEvent(item.rawId, item.userId, { start, end, kind: item.kind });
      }
    } catch (e) {
      showError(e);
    }
    await bus.reloadWeek();
  };

  document.body.classList.add('is-resizing');
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// Переводит вертикальную геометрию (px) в интервал времени дня.
function pxToTimes(day, topPx, heightPx) {
  const gridTop = startOfDay(day);
  gridTop.setHours(GRID.workStartHour, 0, 0, 0);
  const startMin = (topPx / GRID.slotHeightPx) * GRID.slotMinutes;
  const durMin = (heightPx / GRID.slotHeightPx) * GRID.slotMinutes;
  const start = new Date(gridTop.getTime() + startMin * 60000);
  const end = new Date(start.getTime() + durMin * 60000);
  return { start, end };
}

function edgeMark(pos, text) {
  const m = el('div', `cal-block__edge cal-block__edge--${pos}`);
  m.textContent = text;
  return m;
}

// --- Вспомогательное ------------------------------------------------------

function slotTime(day, slotIndex) {
  const d = startOfDay(day);
  const minutes = GRID.workStartHour * 60 + slotIndex * GRID.slotMinutes;
  d.setMinutes(minutes);
  return d;
}

function shortName(name) {
  const parts = String(name).split(' ');
  if (parts.length >= 2) return `${parts[0]} ${parts[1][0]}.`;
  return name;
}

function el(tag, className) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}
