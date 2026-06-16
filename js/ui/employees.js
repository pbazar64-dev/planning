// Мультиселект сотрудников в шапке (до 5) и попап настроек (шестерёнка).
// Выбор сохраняется в настройках приложения Битрикс24 и применяется сразу.

import { GRID } from '../config.js';
import { state, setSelectedUserIds, emit } from '../state.js';
import { saveSelectedUserIds } from '../data.js';
import { bus } from '../bus.js';
import { showError, showToast } from './toast.js';

let headerButton = null; // ссылка на кнопку шапки для обновления подписи

async function applySelection(ids) {
  setSelectedUserIds(ids);
  if (headerButton) refreshLabel(headerButton);
  emit(); // мгновенно перерисовать колонки/шапку
  try {
    await saveSelectedUserIds(state.selectedUserIds);
  } catch (e) {
    showError(e);
  }
  await bus.reloadWeek();
}

// --- Выпадающий мультиселект в шапке --------------------------------------

export function renderHeaderPicker(container) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'emp-picker';

  const button = document.createElement('button');
  button.className = 'emp-picker__button';
  headerButton = button;
  button.appendChild(labelSpan());
  button.insertAdjacentHTML('beforeend', '<span class="emp-picker__caret">▾</span>');
  wrap.appendChild(button);

  const panel = buildCheckboxPanel({
    getSelected: () => new Set(state.selectedUserIds),
    onChange: (ids) => { applySelection(ids); refreshLabel(button); },
  });
  panel.classList.add('emp-picker__panel');
  panel.style.display = 'none';
  wrap.appendChild(panel);

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    if (open) panel.refresh();
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) panel.style.display = 'none';
  });

  container.appendChild(wrap);
  refreshLabel(button);
}

function labelSpan() {
  const s = document.createElement('span');
  s.className = 'emp-picker__label';
  return s;
}

function refreshLabel(button) {
  const span = button.querySelector('.emp-picker__label');
  const ids = state.selectedUserIds;
  if (ids.length === 0) {
    span.textContent = 'Выберите сотрудников';
    return;
  }
  const byId = new Map(state.allUsers.map((u) => [u.id, u]));
  const names = ids.map((id) => (byId.get(id) || {}).name || ('ID ' + id));
  span.textContent = `${names.length} выбрано: ${names.map(short).join(', ')}`;
}

function short(name) {
  const p = String(name).split(' ');
  return p.length >= 2 ? `${p[0]} ${p[1][0]}.` : name;
}

// --- Настройки (шестерёнка) -----------------------------------------------

export function openSettings() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'modal';
  dialog.style.maxWidth = '460px';
  dialog.innerHTML =
    '<div class="modal__head"><div class="modal__title">Настройки</div>' +
    '<button class="modal__close">×</button></div>';

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'modal__body';
  bodyWrap.innerHTML =
    `<div class="form__meta">Сотрудники по умолчанию (до ${GRID.maxEmployees}). ` +
    'Сохраняются в настройках приложения и подгружаются при каждом запуске.</div>';

  // Локальный выбор в попапе, применяется по «Сохранить».
  let localIds = [...state.selectedUserIds];
  const panel = buildCheckboxPanel({
    getSelected: () => new Set(localIds),
    onChange: (ids) => { localIds = ids; },
    embedded: true,
  });
  bodyWrap.appendChild(panel);

  const footer = document.createElement('div');
  footer.className = 'modal__footer';
  footer.innerHTML =
    '<button class="btn btn--ghost" data-act="cancel">Отмена</button>' +
    '<button class="btn btn--primary" data-act="save">Сохранить</button>';
  bodyWrap.appendChild(footer);
  dialog.appendChild(bodyWrap);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const destroy = () => overlay.remove();
  dialog.querySelector('.modal__close').addEventListener('click', destroy);
  footer.querySelector('[data-act=cancel]').addEventListener('click', destroy);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) destroy(); });
  footer.querySelector('[data-act=save]').addEventListener('click', async () => {
    await applySelection(localIds);
    showToast('Настройки сохранены', 'success');
    destroy();
  });
}

// --- Переиспользуемая панель с чекбоксами ----------------------------------

function buildCheckboxPanel({ getSelected, onChange, embedded }) {
  const panel = document.createElement('div');
  panel.className = 'emp-panel' + (embedded ? ' emp-panel--embedded' : '');

  const search = document.createElement('input');
  search.className = 'emp-panel__search';
  search.type = 'text';
  search.placeholder = 'Поиск сотрудника…';
  panel.appendChild(search);

  const counter = document.createElement('div');
  counter.className = 'emp-panel__counter';
  panel.appendChild(counter);

  const list = document.createElement('div');
  list.className = 'emp-panel__list';
  panel.appendChild(list);

  function currentSelected() { return new Set(getSelected()); }

  function render() {
    const selected = currentSelected();
    counter.textContent = `Выбрано ${selected.size} из ${GRID.maxEmployees}`;
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    const users = state.allUsers.filter((u) =>
      !q || u.name.toLowerCase().includes(q) || (u.position || '').toLowerCase().includes(q));
    if (users.length === 0) {
      list.innerHTML = '<div class="emp-panel__empty">Ничего не найдено</div>';
      return;
    }
    for (const u of users) {
      const isOn = selected.has(u.id);
      const atLimit = selected.size >= GRID.maxEmployees && !isOn;
      const row = document.createElement('label');
      row.className = 'emp-row' + (atLimit ? ' emp-row--disabled' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isOn;
      cb.disabled = atLimit;
      cb.addEventListener('change', () => {
        const set = currentSelected();
        if (cb.checked) {
          if (set.size >= GRID.maxEmployees) { cb.checked = false; return; }
          set.add(u.id);
        } else {
          set.delete(u.id);
        }
        onChange([...set]);
        render();
      });
      const info = document.createElement('div');
      info.className = 'emp-row__info';
      info.innerHTML = `<div class="emp-row__name">${escapeHtml(u.name)}</div>` +
        (u.position ? `<div class="emp-row__pos">${escapeHtml(u.position)}</div>` : '');
      row.appendChild(cb);
      row.appendChild(info);
      list.appendChild(row);
    }
  }

  search.addEventListener('input', render);
  panel.refresh = render;
  render();
  return panel;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
