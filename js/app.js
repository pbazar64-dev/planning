// Точка входа: инициализация Битрикс24, загрузка данных и связывание UI.

import { init } from './b24.js';
import { state, emit, subscribe, setSelectedUserIds } from './state.js';
import {
  loadUsers, loadSelectedUserIds, loadWeekData, migrateLocalPlacements,
} from './data.js';
import { weekDays, formatDayLabel, addWeeks, startOfWeek } from './dates.js';
import { renderCalendar } from './ui/calendar.js';
import { renderHeaderPicker, openSettings } from './ui/employees.js';
import { bus } from './bus.js';
import { showError } from './ui/toast.js';

const $ = (sel) => document.querySelector(sel);

async function boot() {
  bindHeader();
  subscribe(renderAll);

  try {
    await init();
  } catch (e) {
    showError(e);
    $('#calendar').innerHTML =
      '<div class="cal-empty"><div class="cal-empty__icon">⚠</div>' +
      '<div class="cal-empty__text">Откройте приложение внутри портала Битрикс24.</div></div>';
    return;
  }

  await loadInitialData();
}

async function loadInitialData() {
  state.loading = true; emit();
  try {
    const [users, savedIds] = await Promise.all([loadUsers(), loadSelectedUserIds()]);
    state.allUsers = users;
    // Оставляем только реально существующих сотрудников.
    const valid = new Set(users.map((u) => u.id));
    setSelectedUserIds(savedIds.filter((id) => valid.has(id)));
    renderHeaderPicker($('#emp-picker'));
  } catch (e) {
    showError(e);
  } finally {
    state.loading = false; emit();
  }
  // Перенос старых локальных размещений в общее хранилище (разово).
  await migrateLocalPlacements();
  await reloadWeek();
}

async function reloadWeek() {
  if (state.selectedUserIds.length === 0) {
    state.dataByUser = new Map();
    emit();
    return;
  }
  state.loading = true; state.error = null; emit();
  try {
    state.dataByUser = await loadWeekData(state.selectedUserIds, state.currentWeek);
  } catch (e) {
    state.error = e;
    showError(e);
  } finally {
    state.loading = false; emit();
  }
}
bus.reloadWeek = reloadWeek;

// --- Шапка ----------------------------------------------------------------

function bindHeader() {
  $('#nav-prev').addEventListener('click', () => changeWeek(-1));
  $('#nav-next').addEventListener('click', () => changeWeek(1));
  $('#nav-today').addEventListener('click', () => {
    state.currentWeek = startOfWeek(new Date());
    reloadWeek();
  });
  $('#btn-settings').addEventListener('click', openSettings);
}

function changeWeek(delta) {
  state.currentWeek = addWeeks(state.currentWeek, delta);
  reloadWeek();
}

// --- Рендер по изменению состояния ----------------------------------------

function renderAll() {
  updateWeekLabel();
  updateLoading();
  renderCalendar($('#calendar'));
}

function updateWeekLabel() {
  const days = weekDays(state.currentWeek);
  const first = days[0];
  const last = days[days.length - 1];
  $('#week-label').textContent = `${formatDayLabel(first)} — ${formatDayLabel(last)}`;
}

function updateLoading() {
  document.body.classList.toggle('is-loading', !!state.loading);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
