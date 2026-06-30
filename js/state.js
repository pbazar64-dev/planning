// Центральное состояние приложения и простейшая шина событий.

import { GRID } from './config.js';
import { startOfWeek } from './dates.js';

const listeners = new Set();

export const state = {
  allUsers: [],          // [{id, name, position, photo}]
  portalDomain: null,    // домен портала Битрикс24 (для ссылок на задачи)
  selectedUserIds: [],   // выбранные сотрудники (до 5)
  currentWeek: startOfWeek(new Date()),
  dataByUser: new Map(), // Map<userId, item[]>
  loading: false,
  error: null,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (e) { console.error(e); }
  }
}

export function setSelectedUserIds(ids) {
  state.selectedUserIds = ids.map(String).slice(0, GRID.maxEmployees);
}

export function selectedUsers() {
  const byId = new Map(state.allUsers.map((u) => [u.id, u]));
  return state.selectedUserIds.map((id) => byId.get(id)).filter(Boolean);
}

export function itemsFor(userId) {
  return state.dataByUser.get(String(userId)) || [];
}
