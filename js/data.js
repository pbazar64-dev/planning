// Доменный слой: загрузка и сохранение сущностей Битрикс24 через BFF
// (REST vibecode), с приведением их к единой модели «item».
//
// Единая модель:
//   { id, kind: 'task'|'event'|'absence', userId,
//     title, description, start: Date, end: Date,
//     status, hoursFact, hoursPlan, hoursToday, allDay, raw }

import {
  apiGet, apiSend, bffRequest, getOption, setOption, OPTION_KEYS,
} from './b24.js';
import { GRID, TASK_STATUS } from './config.js';
import {
  parseB24Date, toB24DateTime, weekRangeB24, secondsToHours, isToday,
  startOfDay, addDays,
} from './dates.js';

function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.tasks)) return data.tasks;
  if (data && Array.isArray(data.events)) return data.events;
  return [];
}

// --- Сотрудники -----------------------------------------------------------

export async function loadUsers() {
  // Без select — забираем полные записи (поля у vibecode в camelCase: id, name,
  // lastName, …). limit большой: vibecode пагинирует сам. Неактивных и
  // сортировку обрабатываем на клиенте.
  const rows = asArray(await apiGet('/users', { limit: 500 }));
  return rows
    .filter((u) => u && (u.id || u.ID) &&
      u.active !== false && u.ACTIVE !== false && u.ACTIVE !== 'N')
    .map((u) => ({
      id: String(u.id || u.ID),
      name: userName(u),
      position: u.workPosition || u.WORK_POSITION || u.position || '',
      photo: u.personalPhoto || u.PERSONAL_PHOTO || u.photo || '',
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

// Собирает «Фамилия Имя» из любых доступных полей записи сотрудника.
function userName(u) {
  const last = u.lastName || u.LAST_NAME || '';
  const first = u.firstName || u.name || u.NAME || '';
  const combined = [last, first].filter(Boolean).join(' ').trim();
  return combined ||
    u.fullName || u.displayName || u.title ||
    u.email || u.EMAIL || ('ID ' + (u.id || u.ID));
}

// --- Настройки приложения (выбор сотрудников, локально) -------------------

export async function loadSelectedUserIds() {
  const raw = await getOption(OPTION_KEYS.selectedUsers, '[]');
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String).slice(0, GRID.maxEmployees) : [];
  } catch {
    return [];
  }
}

export async function saveSelectedUserIds(ids) {
  await setOption(OPTION_KEYS.selectedUsers, JSON.stringify(ids.map(String).slice(0, GRID.maxEmployees)));
}

// --- Загрузка данных недели ------------------------------------------------

// Автоматически грузим ТОЛЬКО события календаря (встречи/отсутствия).
// Задачи в планировщик автоматически не ставятся — только размещения,
// которые пользователь добавил вручную через окно планировщика.
// Возвращает Map<userId, item[]>.
export async function loadWeekData(userIds, weekDate) {
  const range = weekRangeB24(weekDate);
  const byUser = new Map(userIds.map((id) => [String(id), []]));

  await Promise.all(userIds.map(async (id) => {
    const sid = String(id);
    const items = byUser.get(sid);
    const events = await loadUserEvents(id, range);
    for (const e of events) {
      const item = mapEvent(e, sid);
      if (item) items.push(item);
    }
  }));

  // Размещения задач — только добавленные пользователем вручную.
  const placements = await loadPlacements();
  const placementList = [];
  for (const p of placements) {
    const items = byUser.get(String(p.userId));
    if (items) {
      const it = placementToItem(p);
      items.push(it);
      placementList.push(it);
    }
  }
  await enrichPlacements(placementList);

  return byUser;
}

// Подтягивает к размещениям часы/статус самой задачи (ф/п/с), чтобы они
// отображались так же, как обычные задачи. Часы у всех размещений одной
// задачи одинаковые — это показатели самой задачи.
async function enrichPlacements(items) {
  const byTask = new Map();
  for (const it of items) {
    if (!it.taskId) continue;
    if (!byTask.has(it.taskId)) byTask.set(it.taskId, []);
    byTask.get(it.taskId).push(it);
  }
  if (byTask.size === 0) return;

  const todayStart = startOfDay(new Date());
  const todayEnd = addDays(todayStart, 1);

  await Promise.all([...byTask.keys()].map(async (taskId) => {
    let t = null;
    let timeRows = [];
    try {
      [t, timeRows] = await Promise.all([
        apiGet('/tasks/' + taskId).catch(() => null),
        apiGet('/tasks/' + taskId + '/time').catch(() => []),
      ]);
    } catch (e) { /* best-effort */ }

    let secPlan = 0, secFact = 0, status = null, title = null;
    if (t) {
      const task = Array.isArray(t) ? t[0] : (t.data || t);
      if (task) {
        secPlan = Number(task.timeEstimate || task.TIME_ESTIMATE || 0);
        secFact = Number(task.timeSpentInLogs || task.TIME_SPENT_IN_LOGS || 0);
        const deadline = parseB24Date(task.deadline || task.DEADLINE);
        status = resolveTaskStatus(toStatusCode(task.status != null ? task.status : task.STATUS), deadline);
        title = task.title || task.TITLE || null;
      }
    }
    let secToday = 0;
    for (const r of asArray(timeRows)) {
      const created = parseB24Date(r.createdDate || r.CREATED_DATE || r.createdAt);
      if (created && created >= todayStart && created < todayEnd) {
        secToday += Number(r.seconds || r.SECONDS || 0);
      }
    }
    for (const it of byTask.get(taskId)) {
      it.secPlan = secPlan;
      it.secFact = secFact;
      it.secToday = secToday;
      it.status = status;
      if (title) it.title = title;
    }
  }));
}

async function loadUserEvents(id, range) {
  try {
    const data = await apiGet('/calendar-events', {
      type: 'user', ownerId: id, from: range.from, to: range.to,
    });
    return asArray(data);
  } catch (e) {
    console.warn('Не удалось загрузить события календаря:', e);
    return [];
  }
}

// Статус приходит числом (1..7) либо строкой-перечислением — нормализуем.
const STATUS_STRING_TO_CODE = {
  pending: 2, new: 2,
  inprogress: 3, in_progress: 3,
  supposedlycompleted: 4, almostdone: 4,
  completed: 5, complete: 5, done: 5,
  deferred: 6, paused: 6,
  declined: 7,
};

function toStatusCode(raw) {
  if (raw == null) return NaN;
  if (typeof raw === 'number') return raw;
  const n = Number(raw);
  if (!Number.isNaN(n)) return n;
  return STATUS_STRING_TO_CODE[String(raw).toLowerCase().replace(/[\s-]/g, '_')] ||
         STATUS_STRING_TO_CODE[String(raw).toLowerCase().replace(/[\s_-]/g, '')] || NaN;
}

function resolveTaskStatus(code, deadline) {
  const completed = code === 5 || code === 4;
  if (!completed && deadline && deadline < new Date()) return TASK_STATUS.overdue;
  switch (code) {
    case 3: return TASK_STATUS.inProgress;
    case 6: return TASK_STATUS.deferred;
    case 4:
    case 5: return TASK_STATUS.completed;
    default: return TASK_STATUS.pending;
  }
}

function mapEvent(e, userId) {
  const start = parseB24Date(e.dateFrom || e.DATE_FROM || e.from);
  const end = parseB24Date(e.dateTo || e.DATE_TO || e.to);
  if (!start || !end) return null;

  const accessibility = String(e.accessibility || e.ACCESSIBILITY || '').toLowerCase();
  const isAbsence = accessibility === 'absent';
  const skipTime = (e.skipTime || e.SKIP_TIME) === 'Y' || e.skipTime === true;

  return {
    id: (isAbsence ? 'absence_' : 'event_') + (e.id || e.ID),
    rawId: String(e.id || e.ID),
    kind: isAbsence ? 'absence' : 'event',
    userId,
    title: e.name || e.NAME || (isAbsence ? 'Отсутствие' : 'Событие'),
    description: e.description || e.DESCRIPTION || '',
    start, end,
    allDay: skipTime,
    status: null,
    hoursPlan: 0, hoursFact: 0, hoursToday: 0,
    raw: e,
  };
}

// --- Создание и обновление сущностей --------------------------------------

export async function createTask({ title, userId, description, start, end, hoursPlan }) {
  const body = { title, responsibleId: userId, description: description || '' };
  if (start) body.startDatePlan = toB24DateTime(start);
  if (end) {
    body.endDatePlan = toB24DateTime(end);
    body.deadline = toB24DateTime(end);
  }
  if (hoursPlan) body.timeEstimate = Math.round(Number(hoursPlan) * 3600);
  return apiSend('/tasks', 'POST', body);
}

export async function updateTask(rawId, { title, description, start, end, hoursPlan, status }) {
  const body = {};
  if (title != null) body.title = title;
  if (description != null) body.description = description;
  if (start) body.startDatePlan = toB24DateTime(start);
  if (end) {
    body.endDatePlan = toB24DateTime(end);
    body.deadline = toB24DateTime(end);
  }
  if (hoursPlan != null && hoursPlan !== '') body.timeEstimate = Math.round(Number(hoursPlan) * 3600);
  if (status != null) body.status = status;
  return apiSend('/tasks/' + rawId, 'PATCH', body);
}

// --- «Размещения» задач на сетке (планирование) ---------------------------
// Размещение задачи в ячейке НЕ меняет саму задачу в Битрикс24: ни плановые
// даты, ни дедлайн, ни учёт времени. Одну задачу можно положить в несколько
// слотов параллельно. Хранится ОБЩИМ образом на сервере приложения (BFF,
// /api/placements), поэтому видно всем пользователям портала, а не только
// автору.

export async function loadPlacements() {
  try {
    const json = await bffRequest('/placements');
    return Array.isArray(json.data) ? json.data : [];
  } catch (e) {
    console.warn('Не удалось загрузить размещения:', e);
    return [];
  }
}

export async function addPlacement({ taskId, title, userId, start, end }) {
  await bffRequest('/placements', {
    method: 'POST',
    body: {
      taskId: String(taskId),
      title: title || 'Задача',
      userId: String(userId),
      start: start.toISOString(),
      end: end.toISOString(),
    },
  });
}

export async function updatePlacement(id, { start, end }) {
  const body = {};
  if (start) body.start = start.toISOString();
  if (end) body.end = end.toISOString();
  await bffRequest('/placements/' + encodeURIComponent(id), { method: 'PATCH', body });
}

export async function removePlacement(id) {
  await bffRequest('/placements/' + encodeURIComponent(id), { method: 'DELETE' });
}

// --- Ссылка на задачу в портале -------------------------------------------

export async function loadPortalDomain() {
  try {
    const json = await bffRequest('/portal');
    return (json.data && json.data.portal) || null;
  } catch (e) {
    return null;
  }
}

// Глубокая ссылка на карточку задачи Битрикс24.
export function taskUrl(domain, taskId, userId) {
  if (!domain || !taskId) return null;
  const uid = userId || 0;
  return `https://${domain}/company/personal/user/${uid}/tasks/task/view/${taskId}/`;
}

// Разовая миграция: если у пользователя остались размещения в localStorage
// (старая версия), переносим их в общее серверное хранилище и чистим локальные.
export async function migrateLocalPlacements() {
  let arr;
  try {
    arr = JSON.parse(localStorage.getItem('planner_task_placements') || '[]');
  } catch { return; }
  if (!Array.isArray(arr) || arr.length === 0) return;
  for (const p of arr) {
    try {
      await bffRequest('/placements', {
        method: 'POST',
        body: {
          taskId: String(p.taskId || ''),
          title: p.title || 'Задача',
          userId: String(p.userId || ''),
          start: p.start,
          end: p.end,
        },
      });
    } catch (e) { /* пропускаем сбойные */ }
  }
  try { localStorage.removeItem('planner_task_placements'); } catch (e) { /* ignore */ }
}

// Размещение -> item для рендера календаря.
function placementToItem(p) {
  return {
    id: 'place_' + p.id,
    localId: p.id,
    kind: 'placement',
    userId: String(p.userId),
    taskId: p.taskId,
    title: p.title,
    description: '',
    start: new Date(p.start),
    end: new Date(p.end),
    allDay: false,
    status: null,
    hoursPlan: 0, hoursFact: 0, hoursToday: 0,
    secPlan: 0, secFact: 0, secToday: 0,
    raw: p,
  };
}

// Список задач сотрудника для привязки (активные, не завершённые).
export async function loadUserTasksForPick(userId) {
  const data = await apiSend('/tasks/search', 'POST', {
    filter: { responsibleId: userId },
    select: ['id', 'title', 'status', 'deadline'],
    order: { id: 'desc' },
    limit: 200,
  });
  return asArray(data)
    .filter((t) => {
      const code = toStatusCode(t.status != null ? t.status : t.STATUS);
      return Number.isNaN(code) || code < 5; // прячем завершённые, если статус понятен
    })
    .map((t) => ({
      id: String(t.id || t.ID),
      title: t.title || t.TITLE || 'Без названия',
    }));
}

export async function createEvent({ name, userId, description, start, end, kind }) {
  // Обёртка вызывает calendar.event.add — ему обязательны from/to (а не
  // dateFrom/dateTo). Шлём оба варианта для совместимости.
  const from = toB24DateTime(start);
  const to = toB24DateTime(end);
  return apiSend('/calendar-events', 'POST', {
    type: 'user',
    ownerId: userId,
    name,
    description: description || '',
    from, to, dateFrom: from, dateTo: to,
    accessibility: kind === 'absence' ? 'absent' : 'busy',
  });
}

export async function updateEvent(rawId, userId, { name, description, start, end, kind }) {
  const body = { type: 'user', ownerId: userId };
  if (name != null) body.name = name;
  if (description != null) body.description = description;
  if (start) { const f = toB24DateTime(start); body.from = f; body.dateFrom = f; }
  if (end) { const t = toB24DateTime(end); body.to = t; body.dateTo = t; }
  if (kind) body.accessibility = kind === 'absence' ? 'absent' : 'busy';
  return apiSend('/calendar-events/' + rawId, 'PATCH', body);
}

export async function deleteEvent(rawId, userId) {
  const q = userId ? ('?type=user&ownerId=' + encodeURIComponent(userId)) : '';
  return apiSend('/calendar-events/' + rawId + q, 'DELETE');
}

export async function deleteTask(rawId) {
  return apiSend('/tasks/' + rawId, 'DELETE');
}

export { isToday };
