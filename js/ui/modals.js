// Попапы: меню слота, формы создания/редактирования задач, встреч и отсутствий,
// выбор существующей задачи для привязки к слоту.

import {
  createTask, updateTask, attachTaskToSlot, loadUserTasksForPick,
  createEvent, updateEvent,
} from '../data.js';
import { TASK_STATUS } from '../config.js';
import { toDateTimeInputValue, formatTime, formatDayLabel } from '../dates.js';
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
    ['📋 Выбрать задачу из существующих', () => { modal.destroy(); openPickTask({ user, start, end }); }],
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

export async function openPickTask({ user, start, end }) {
  const body = document.createElement('div');
  body.className = 'modal__body';
  body.innerHTML = '<div class="form__loading">Загрузка задач…</div>';
  const modal = openModal({ title: 'Привязать задачу к слоту', bodyEl: body, width: 460 });

  let tasks;
  try {
    tasks = await loadUserTasksForPick(user.id);
  } catch (e) { showError(e); modal.destroy(); return; }

  body.innerHTML = '';
  if (tasks.length === 0) {
    body.innerHTML = '<div class="form__loading">У сотрудника нет активных задач.</div>';
    return;
  }
  const search = inputRow('Поиск', 'text', '');
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
          await attachTaskToSlot(t.id, start, end);
          showToast('Задача привязана к слоту', 'success');
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

export function openTaskForm({ mode, user, start, end, item }) {
  const body = document.createElement('div');
  body.className = 'modal__body';

  const isEdit = mode === 'edit';
  const u = user || selectedUsers().find((x) => x.id === item.userId) || { id: item && item.userId, name: '' };

  const fTitle = inputRow('Название задачи *', 'text', isEdit ? item.title : '');
  const fStart = inputRow('Начало', 'datetime-local', toDateTimeInputValue(isEdit ? item.start : start));
  const fEnd = inputRow('Окончание', 'datetime-local', toDateTimeInputValue(isEdit ? item.end : end));
  const fHours = inputRow('Плановые часы', 'number', isEdit ? item.hoursPlan : '');
  fHours.input.step = '0.5'; fHours.input.min = '0';
  const fDesc = textareaRow('Описание', isEdit ? stripHtml(item.description) : '');

  body.appendChild(metaLine(`Сотрудник: ${u.name || ('ID ' + u.id)}`));
  body.appendChild(fTitle.row);
  body.appendChild(fStart.row);
  body.appendChild(fEnd.row);
  body.appendChild(fHours.row);

  let fStatus;
  if (isEdit) {
    fStatus = selectRow('Статус', statusOptions(), String(item.status ? item.status.code : 2));
    body.appendChild(fStatus.row);
  }
  body.appendChild(fDesc.row);

  const modal = openModal({ title: isEdit ? 'Редактирование задачи' : 'Создать задачу', bodyEl: body });
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

    if (isEdit) {
      await updateTask(item.rawId, { ...payload, status: fStatus ? Number(fStatus.input.value) : undefined });
      showToast('Задача обновлена', 'success');
    } else {
      await createTask({ ...payload, userId: u.id });
      showToast('Задача создана', 'success');
    }
  });
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

export function openEventForm({ mode, kind, user, start, end, item }) {
  const body = document.createElement('div');
  body.className = 'modal__body';

  const isEdit = mode === 'edit';
  const realKind = isEdit ? item.kind : kind;
  const u = user || selectedUsers().find((x) => x.id === item.userId) || { id: item && item.userId, name: '' };
  const isAbsence = realKind === 'absence';

  const fName = inputRow(isAbsence ? 'Причина отсутствия *' : 'Название встречи *', 'text', isEdit ? item.title : '');
  const fStart = inputRow('Начало', 'datetime-local', toDateTimeInputValue(isEdit ? item.start : start));
  const fEnd = inputRow('Окончание', 'datetime-local', toDateTimeInputValue(isEdit ? item.end : end));
  const fDesc = textareaRow('Описание', isEdit ? stripHtml(item.description) : '');

  body.appendChild(metaLine(`Сотрудник: ${u.name || ('ID ' + u.id)}`));
  body.appendChild(fName.row);
  body.appendChild(fStart.row);
  body.appendChild(fEnd.row);
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

    if (isEdit) {
      await updateEvent(item.rawId, u.id, { name, description: fDesc.input.value, start: s, end: e, kind: realKind });
      showToast(isAbsence ? 'Отсутствие обновлено' : 'Встреча обновлена', 'success');
    } else {
      await createEvent({ name, userId: u.id, description: fDesc.input.value, start: s, end: e, kind: realKind });
      showToast(isAbsence ? 'Отсутствие добавлено' : 'Встреча создана', 'success');
    }
  });
}

// --- Диспетчер редактирования по типу сущности ----------------------------

export function openEditModal(item) {
  if (item.kind === 'task') openTaskForm({ mode: 'edit', item });
  else openEventForm({ mode: 'edit', item });
}

// --- Общие элементы формы -------------------------------------------------

function addFooter(body, modal, onSubmit) {
  const footer = document.createElement('div');
  footer.className = 'modal__footer';
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
