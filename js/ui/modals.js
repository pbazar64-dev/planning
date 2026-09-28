// Попапы: меню слота, формы создания/редактирования задач, встреч и отсутствий,
// выбор существующей задачи для привязки к слоту, настройка повторения.

import {
  createTaskWithSchedule, updateTask, attachTaskToSlot, loadUserTasksForPick,
  createTaskSlot, updateTaskSlot, deleteCalendarEvent, loadEventSeries,
  createEvent, updateEvent,
} from '../data.js';
import { TASK_STATUS } from '../config.js';
import { toDateTimeInputValue, toDateInputValue, formatTime, formatDayLabel, addDays } from '../dates.js';
import {
  RECUR_FREQS, RECUR_END_MODES, RECUR_WEEKDAYS, weekdayCode, isRecurring,
  validateRule, describeRule,
} from '../recurrence.js';
import { selectedUsers } from '../state.js';
import { bus } from '../bus.js';
import { showToast, showError } from './toast.js';

// --- Базовый модальный каркас ---------------------------------------------

function openModal({ title, bodyEl, width = 420 }) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'modal';
  dialog.style.maxWidth = width + 'px';

  const head = document.createElement('div');
  head.className = 'modal__head';
  head.innerHTML = `<div class="modal__title">${escapeHtml(title)}</div>`;
  const close = document.createElement('button');
  close.className = 'modal__close';
  close.textContent = '×';
  close.addEventListener('click', () => destroy());
  head.appendChild(close);

  dialog.appendChild(head);
  dialog.appendChild(bodyEl);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const onKey = (e) => { if (e.key === 'Escape') destroy(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) destroy(); });
  document.addEventListener('keydown', onKey);

  function destroy() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  return { overlay, destroy };
}

// --- Меню при клике по пустому слоту --------------------------------------

export function openSlotMenu({ user, start, end }) {
  const body = document.createElement('div');
  body.className = 'modal__body slot-menu';

  const hint = document.createElement('div');
  hint.className = 'slot-menu__hint';
  hint.textContent = `${user.name} · ${formatDayLabel(start)} · ${formatTime(start)}–${formatTime(end)}`;
  body.appendChild(hint);

  const actions = [
    ['＋ Создать задачу', () => { modal.destroy(); openTaskForm({ mode: 'create', user, start, end }); }],
    ['📋 Запланировать существующую задачу', () => { modal.destroy(); openPickTask({ user, start, end }); }],
    ['📅 Создать встречу', () => { modal.destroy(); openEventForm({ mode: 'create', kind: 'event', user, start, end }); }],
    ['🌴 Добавить отсутствие', () => { modal.destroy(); openEventForm({ mode: 'create', kind: 'absence', user, start, end }); }],
  ];
  for (const [label, fn] of actions) {
    const btn = document.createElement('button');
    btn.className = 'slot-menu__item';
    btn.textContent = label;
    btn.addEventListener('click', fn);
    body.appendChild(btn);
  }

  const modal = openModal({ title: 'Что создать?', bodyEl: body, width: 360 });
}

// --- Выбор существующей задачи --------------------------------------------
// Задача не копируется и не переносится: в календаре сотрудника создаётся
// слот работы над ней (при желании — повторяющийся).

export async function openPickTask({ user, start, end }) {
  const body = document.createElement('div');
  body.className = 'modal__body';
  body.innerHTML = '<div class="form__loading">Загрузка задач…</div>';
  const modal = openModal({ title: 'Запланировать работу над задачей', bodyEl: body, width: 460 });

  let tasks;
  try {
    tasks = await loadUserTasksForPick(user.id);
  } catch (e) { showError(e); modal.destroy(); return; }

  body.innerHTML = '';
  if (tasks.length === 0) {
    body.innerHTML = '<div class="form__loading">У сотрудника нет активных задач.</div>';
    return;
  }
  body.appendChild(metaLine(`${user.name} · ${formatDayLabel(start)} · ${formatTime(start)}–${formatTime(end)}`));

  const fStart = inputRow('Начало', 'datetime-local', toDateTimeInputValue(start));
  const fEnd = inputRow('Окончание', 'datetime-local', toDateTimeInputValue(end));
  body.appendChild(fStart.row);
  body.appendChild(fEnd.row);
  const fRepeat = recurrenceField(fStart.input, fEnd.input, null);
  body.appendChild(fRepeat.row);

  const search = inputRow('Задача', 'text', '');
  search.input.placeholder = 'Поиск по названию';
  body.appendChild(search.row);

  const list = document.createElement('div');
  list.className = 'pick-list';
  body.appendChild(list);

  const render = (q) => {
    list.innerHTML = '';
    const filtered = tasks.filter((t) => t.title.toLowerCase().includes(q.toLowerCase()));
    for (const t of filtered) {
      const item = document.createElement('button');
      item.className = 'pick-list__item';
      item.textContent = t.title;
      item.addEventListener('click', async () => {
        try {
          const s = new Date(fStart.input.value);
          const e = new Date(fEnd.input.value);
          if (!(e > s)) throw new Error('Окончание должно быть позже начала');
          const rule = fRepeat.getRule();
          validateRule(rule, s);
          await attachTaskToSlot({ taskId: t.id, title: t.title, userId: user.id, start: s, end: e, rule });
          showToast(isRecurring(rule) ? 'Работа над задачей запланирована с повторением' : 'Задача запланирована в слот', 'success');
          modal.destroy();
          await bus.reloadWeek();
        } catch (e) { showError(e); }
      });
      list.appendChild(item);
    }
  };
  search.input.addEventListener('input', () => render(search.input.value));
  render('');
}

// --- Форма задачи (создание/редактирование) -------------------------------
// Повторение задачи — это повторяющийся слот работы над ней в календаре;
// задача в Битрикс24 остаётся одна.

export async function openTaskForm({ mode, user, start, end, item }) {
  const isEdit = mode === 'edit';
  const isSlot = isEdit && !!item.slot;
  const u = user || selectedUsers().find((x) => x.id === item.userId) || { id: item && item.userId, name: '' };

  // Для повторяющегося слота редактируем серию целиком: берём её начало и правило.
  let series = null;
  if (isSlot && item.recurring) {
    try {
      series = await loadEventSeries(item.slot.eventId);
    } catch (e) { showError(e); return; }
  }
  const seriesRuleUnsupported = !!series && !series.rule;

  const body = document.createElement('div');
  body.className = 'modal__body';

  const startVal = series ? series.start : (isEdit ? item.start : start);
  const endVal = series ? series.end : (isEdit ? item.end : end);

  const fTitle = inputRow('Название задачи *', 'text', isEdit ? item.title : '');
  const fStart = inputRow(series ? 'Начало серии' : 'Начало', 'datetime-local', toDateTimeInputValue(startVal));
  const fEnd = inputRow(series ? 'Окончание (первое вхождение)' : 'Окончание', 'datetime-local', toDateTimeInputValue(endVal));
  const fHours = inputRow('Плановые часы', 'number', isEdit ? item.hoursPlan : '');
  fHours.input.step = '0.5'; fHours.input.min = '0';
  const fDesc = textareaRow('Описание задачи', isEdit ? stripHtml(item.description) : '');

  body.appendChild(metaLine(`Сотрудник: ${u.name || ('ID ' + u.id)}`));
  if (isSlot) {
    body.appendChild(metaLine('Ячейка — запланированная работа над задачей. Время и повторение меняются ' +
      'только у этой ячейки (серии), сама задача в Битрикс24 одна.'));
  }
  body.appendChild(fTitle.row);
  body.appendChild(fStart.row);
  body.appendChild(fEnd.row);

  let fRepeat = null;
  if (seriesRuleUnsupported) {
    fStart.input.disabled = true; fEnd.input.disabled = true;
    body.appendChild(metaLine(`🔁 ${item.recurrenceLabel}. Это правило повторения меняйте в календаре Битрикс24.`));
  } else {
    fRepeat = recurrenceField(fStart.input, fEnd.input, series ? series.rule : null);
    body.appendChild(fRepeat.row);
  }
  body.appendChild(fHours.row);

  let fStatus;
  if (isEdit) {
    fStatus = selectRow('Статус', statusOptions(), String(item.status ? item.status.code : 2));
    body.appendChild(fStatus.row);
  }
  body.appendChild(fDesc.row);

  const title = isEdit ? (isSlot ? 'Работа над задачей' : 'Редактирование задачи') : 'Создать задачу';
  const modal = openModal({ title, bodyEl: body });

  const extra = [];
  if (isSlot) {
    extra.push([item.recurring ? 'Убрать серию из планировщика' : 'Убрать из планировщика', async () => {
      const q = item.recurring
        ? 'Убрать все повторения этой работы из планировщика? Задача в Битрикс24 останется.'
        : 'Убрать ячейку из планировщика? Задача в Битрикс24 останется.';
      if (!window.confirm(q)) return false;
      await deleteCalendarEvent(item.slot.eventId, item.slot.ownerId);
      showToast('Ячейка убрана из планировщика', 'success');
      return true;
    }]);
  }

  addFooter(body, modal, async () => {
    const payload = {
      title: fTitle.input.value.trim(),
      description: fDesc.input.value,
      start: new Date(fStart.input.value),
      end: new Date(fEnd.input.value),
      hoursPlan: fHours.input.value,
    };
    if (!payload.title) throw new Error('Укажите название задачи');
    if (!(payload.end > payload.start)) throw new Error('Окончание должно быть позже начала');
    const rule = fRepeat ? fRepeat.getRule() : undefined;
    if (rule) validateRule(rule, payload.start);
    const status = fStatus ? Number(fStatus.input.value) : undefined;

    if (isSlot) {
      // Поля задачи — в задачу (без дат), время и повторение — в слот.
      await updateTask(item.rawId, { title: payload.title, description: payload.description,
        hoursPlan: payload.hoursPlan, status });
      const slotChange = { title: payload.title };
      if (!seriesRuleUnsupported) {
        slotChange.start = payload.start;
        slotChange.end = payload.end;
        // Правило отправляем, если серия была или появилась.
        if (item.recurring || isRecurring(rule)) slotChange.rule = rule;
      }
      await updateTaskSlot(item.slot.eventId, item.slot.ownerId, slotChange);
      showToast('Задача обновлена', 'success');
    } else if (isEdit) {
      if (isRecurring(rule)) {
        // Обычная задача становится повторяющейся: плановые даты — первое
        // вхождение, повторения — серией слотов в календаре.
        await updateTask(item.rawId, { ...payload, status, withDeadline: false });
        await createTaskSlot({ taskId: item.rawId, title: payload.title, userId: u.id,
          start: payload.start, end: payload.end, rule });
        showToast('Задача обновлена, повторения запланированы', 'success');
      } else {
        await updateTask(item.rawId, { ...payload, status });
        showToast('Задача обновлена', 'success');
      }
    } else {
      await createTaskWithSchedule({ ...payload, userId: u.id }, rule);
      showToast(isRecurring(rule) ? 'Задача создана, повторения запланированы' : 'Задача создана', 'success');
    }
  }, extra);
}

function statusOptions() {
  return [
    [String(TASK_STATUS.pending.code), TASK_STATUS.pending.label],
    [String(TASK_STATUS.inProgress.code), TASK_STATUS.inProgress.label],
    [String(TASK_STATUS.deferred.code), TASK_STATUS.deferred.label],
    [String(TASK_STATUS.completed.code), TASK_STATUS.completed.label],
  ];
}


// --- Форма встречи / отсутствия -------------------------------------------

export async function openEventForm({ mode, kind, user, start, end, item }) {
  const isEdit = mode === 'edit';
  const realKind = isEdit ? item.kind : kind;
  const u = user || selectedUsers().find((x) => x.id === item.userId) || { id: item && item.userId, name: '' };
  const isAbsence = realKind === 'absence';

  // Повторяющееся событие правится серией: берём её начало и правило.
  let series = null;
  if (isEdit && item.recurring) {
    try {
      series = await loadEventSeries(item.rawId);
    } catch (e) { showError(e); return; }
  }
  const seriesRuleUnsupported = !!series && !series.rule;

  const body = document.createElement('div');
  body.className = 'modal__body';

  const startVal = series ? series.start : (isEdit ? item.start : start);
  const endVal = series ? series.end : (isEdit ? item.end : end);

  const fName = inputRow(isAbsence ? 'Причина отсутствия *' : 'Название встречи *', 'text', isEdit ? item.title : '');
  const fStart = inputRow(series ? 'Начало серии' : 'Начало', 'datetime-local', toDateTimeInputValue(startVal));
  const fEnd = inputRow(series ? 'Окончание (первое вхождение)' : 'Окончание', 'datetime-local', toDateTimeInputValue(endVal));
  const fDesc = textareaRow('Описание', isEdit ? stripHtml(item.description) : '');

  body.appendChild(metaLine(`Сотрудник: ${u.name || ('ID ' + u.id)}`));
  if (series) {
    body.appendChild(metaLine('🔁 Событие повторяется — изменения применятся ко всей серии.'));
  }
  body.appendChild(fName.row);
  body.appendChild(fStart.row);
  body.appendChild(fEnd.row);

  let fRepeat = null;
  if (seriesRuleUnsupported) {
    fStart.input.disabled = true; fEnd.input.disabled = true;
    body.appendChild(metaLine(`${item.recurrenceLabel}. Время и это правило повторения меняйте в календаре Битрикс24.`));
  } else {
    fRepeat = recurrenceField(fStart.input, fEnd.input, series ? series.rule : null);
    body.appendChild(fRepeat.row);
  }
  body.appendChild(fDesc.row);

  const title = isAbsence
    ? (isEdit ? 'Редактирование отсутствия' : 'Добавить отсутствие')
    : (isEdit ? 'Редактирование встречи' : 'Создать встречу');
  const modal = openModal({ title, bodyEl: body });

  addFooter(body, modal, async () => {
    const name = fName.input.value.trim();
    const s = new Date(fStart.input.value);
    const e = new Date(fEnd.input.value);
    if (!name) throw new Error('Укажите название');
    if (!(e > s)) throw new Error('Окончание должно быть позже начала');
    const rule = fRepeat ? fRepeat.getRule() : undefined;
    if (rule) validateRule(rule, s);

    if (isEdit) {
      const change = { name, description: fDesc.input.value, kind: realKind };
      if (!seriesRuleUnsupported) {
        change.start = s;
        change.end = e;
        if (item.recurring || isRecurring(rule)) change.rule = rule;
      }
      await updateEvent(item.rawId, u.id, change);
      showToast(isAbsence ? 'Отсутствие обновлено' : 'Встреча обновлена', 'success');
    } else {
      await createEvent({ name, userId: u.id, description: fDesc.input.value, start: s, end: e, kind: realKind, rule });
      const suffix = isRecurring(rule) ? ' (повторяющееся)' : '';
      showToast((isAbsence ? 'Отсутствие добавлено' : 'Встреча создана') + suffix, 'success');
    }
  });
}

// --- Диспетчер редактирования по типу сущности ----------------------------

export function openEditModal(item) {
  if (item.kind === 'task') openTaskForm({ mode: 'edit', item });
  else openEventForm({ mode: 'edit', item });
}

// --- Блок «Повторение» ----------------------------------------------------
// startInput/endInput — поля начала и окончания формы (для подсказки и дня
// недели по умолчанию). initial — правило для предзаполнения (или null).

function recurrenceField(startInput, endInput, initial) {
  const init = initial || { freq: 'none', interval: 1, byDay: [], endMode: 'never', count: 10, until: null };

  const row = document.createElement('div');
  row.className = 'form__row recur';

  const fFreq = selectRow('Повторение', RECUR_FREQS, init.freq);
  fFreq.row.classList.add('recur__freq');
  row.appendChild(fFreq.row);

  const details = document.createElement('div');
  details.className = 'recur__details';
  row.appendChild(details);

  // «Каждые N …»
  const fInterval = inputRow('Каждые', 'number', String(init.interval || 1));
  fInterval.input.min = '1'; fInterval.input.max = '99'; fInterval.input.step = '1';
  const intervalUnit = document.createElement('span');
  intervalUnit.className = 'recur__unit';
  fInterval.row.classList.add('recur__interval');
  fInterval.row.appendChild(intervalUnit);
  details.appendChild(fInterval.row);

  // Дни недели для «Еженедельно».
  const daysRow = document.createElement('div');
  daysRow.className = 'form__row recur__days';
  const daysLabel = document.createElement('span');
  daysLabel.className = 'form__label';
  daysLabel.textContent = 'По дням';
  daysRow.appendChild(daysLabel);
  const dayBoxes = new Map();
  for (const [code, label] of RECUR_WEEKDAYS) {
    const chip = document.createElement('label');
    chip.className = 'recur__day';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = code;
    cb.checked = (init.byDay || []).includes(code);
    chip.appendChild(cb);
    chip.appendChild(document.createTextNode(label));
    daysRow.appendChild(chip);
    dayBoxes.set(code, cb);
  }
  details.appendChild(daysRow);

  // Окончание серии: никогда, после N раз или в дату.
  const fEndMode = selectRow('Завершить', RECUR_END_MODES, init.endMode || 'never');
  details.appendChild(fEndMode.row);
  const fCount = inputRow('Количество повторений (вместе с первым)', 'number', String(init.count || 10));
  fCount.input.min = '2'; fCount.input.step = '1';
  details.appendChild(fCount.row);
  const fUntil = inputRow('Повторять до (включительно)', 'date', init.until ? toDateInputValue(init.until) : '');
  details.appendChild(fUntil.row);

  const summary = document.createElement('div');
  summary.className = 'form__meta recur__summary';
  details.appendChild(summary);

  let daysTouched = (init.byDay || []).length > 0;
  for (const cb of dayBoxes.values()) cb.addEventListener('change', () => { daysTouched = true; refresh(); });

  function getRule() {
    return {
      freq: fFreq.input.value,
      interval: Math.floor(Number(fInterval.input.value)) || 0,
      byDay: [...dayBoxes.values()].filter((cb) => cb.checked).map((cb) => cb.value),
      endMode: fEndMode.input.value,
      count: Math.floor(Number(fCount.input.value)) || 0,
      until: fUntil.input.value ? new Date(fUntil.input.value + 'T00:00') : null,
    };
  }

  function refresh() {
    const freq = fFreq.input.value;
    const start = new Date(startInput.value);
    const end = new Date(endInput.value);
    details.hidden = freq === 'none';
    fInterval.row.hidden = freq === 'workdays';
    daysRow.hidden = freq !== 'weekly';
    fCount.row.hidden = fEndMode.input.value !== 'count';
    fUntil.row.hidden = fEndMode.input.value !== 'until';
    intervalUnit.textContent = { daily: 'дн.', weekly: 'нед.', monthly: 'мес.' }[freq] || '';

    // По умолчанию — день недели начала; дата окончания — через месяц.
    if (!isNaN(start)) {
      if (!daysTouched) {
        const code = weekdayCode(start);
        for (const [c, cb] of dayBoxes) cb.checked = c === code;
      }
      if (!fUntil.input.value) fUntil.input.value = toDateInputValue(addDays(start, 30));
    }

    if (freq === 'none') return;
    try {
      if (isNaN(start) || !(end > start)) throw new Error('Укажите начало и окончание');
      const rule = getRule();
      validateRule(rule, start);
      summary.textContent = '🔁 ' + describeRule(rule);
      summary.classList.remove('recur__summary--error');
    } catch (e) {
      summary.textContent = e.message;
      summary.classList.add('recur__summary--error');
    }
  }

  for (const inp of [fFreq.input, fInterval.input, fEndMode.input, fCount.input, fUntil.input, startInput, endInput]) {
    inp.addEventListener('input', refresh);
    inp.addEventListener('change', refresh);
  }
  refresh();

  return { row, getRule };
}

// --- Общие элементы формы -------------------------------------------------

// extra — дополнительные кнопки слева: [[текст, async () => закрыть?], ...].
function addFooter(body, modal, onSubmit, extra = []) {
  const footer = document.createElement('div');
  footer.className = 'modal__footer';
  for (const [label, fn] of extra) {
    const btn = document.createElement('button');
    btn.className = 'btn btn--danger';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (await fn()) {
          modal.destroy();
          await bus.reloadWeek();
          return;
        }
      } catch (e) { showError(e); }
      btn.disabled = false;
    });
    footer.appendChild(btn);
  }
  const cancel = document.createElement('button');
  cancel.className = 'btn btn--ghost';
  cancel.textContent = 'Отмена';
  cancel.addEventListener('click', () => modal.destroy());
  const save = document.createElement('button');
  save.className = 'btn btn--primary';
  save.textContent = 'Сохранить';
  save.addEventListener('click', async () => {
    save.disabled = true; save.textContent = 'Сохранение…';
    try {
      await onSubmit();
      modal.destroy();
      await bus.reloadWeek();
    } catch (e) {
      showError(e);
      save.disabled = false; save.textContent = 'Сохранить';
    }
  });
  footer.appendChild(cancel);
  footer.appendChild(save);
  body.appendChild(footer);
}

function metaLine(text) {
  const d = document.createElement('div');
  d.className = 'form__meta';
  d.textContent = text;
  return d;
}

function inputRow(label, type, value) {
  const row = document.createElement('label');
  row.className = 'form__row';
  const span = document.createElement('span');
  span.className = 'form__label';
  span.textContent = label;
  const input = document.createElement('input');
  input.className = 'form__input';
  input.type = type;
  if (value !== undefined && value !== null) input.value = value;
  row.appendChild(span); row.appendChild(input);
  return { row, input };
}

function textareaRow(label, value) {
  const row = document.createElement('label');
  row.className = 'form__row';
  const span = document.createElement('span');
  span.className = 'form__label';
  span.textContent = label;
  const input = document.createElement('textarea');
  input.className = 'form__input form__textarea';
  input.rows = 3;
  input.value = value || '';
  row.appendChild(span); row.appendChild(input);
  return { row, input };
}

function selectRow(label, options, value) {
  const row = document.createElement('label');
  row.className = 'form__row';
  const span = document.createElement('span');
  span.className = 'form__label';
  span.textContent = label;
  const input = document.createElement('select');
  input.className = 'form__input';
  for (const [val, text] of options) {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = text;
    if (val === value) opt.selected = true;
    input.appendChild(opt);
  }
  row.appendChild(span); row.appendChild(input);
  return { row, input };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function stripHtml(s) {
  return String(s || '').replace(/<br\s*\/?>(?=)/gi, '\n').replace(/<[^>]*>/g, '').trim();
}
