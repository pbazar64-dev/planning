// Доменный слой: загрузка и сохранение сущностей Битрикс24 через BFF
// (REST vibecode), с приведением их к единой модели «item».
//
// Единая модель:
//   { id, kind: 'task'|'event'|'absence', userId,
//     title, description, start: Date, end: Date,
//     status, hoursFact, hoursPlan, hoursToday, allDay, raw }

import {
  apiGet, apiSend, getOption, setOption, OPTION_KEYS,
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
  // limit достаточно большой — vibecode пагинирует сам; неактивных и сортировку
  // обрабатываем на клиенте (так надёжнее межпортально).
  const rows = asArray(await apiGet('/users', {
    select: 'ID,NAME,LAST_NAME,WORK_POSITION,PERSONAL_PHOTO,ACTIVE,EMAIL',
    limit: 500,
  }));
  return rows
    .filter((u) => u && (u.ID || u.id) &&
      u.ACTIVE !== false && u.ACTIVE !== 'N' && u.active !== false)
    .map((u) => {
      const last = u.LAST_NAME || u.lastName || '';
      const first = u.NAME || u.name || '';
      const name = [last, first].filter(Boolean).join(' ').trim() ||
        first || u.EMAIL || u.email || ('ID ' + (u.ID || u.id));
      return {
        id: String(u.ID || u.id),
        name,
        position: u.WORK_POSITION || u.workPosition || '',
        photo: u.PERSONAL_PHOTO || u.personalPhoto || '',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
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

const TASK_SELECT = [
  'id', 'title', 'status', 'responsibleId', 'description',
  'deadline', 'startDatePlan', 'endDatePlan',
  'timeEstimate', 'timeSpentInLogs',
];

// Загружает задачи, события и отсутствия для всех сотрудников за неделю.
// Возвращает Map<userId, item[]>.
export async function loadWeekData(userIds, weekDate) {
  const range = weekRangeB24(weekDate);
  const byUser = new Map(userIds.map((id) => [String(id), []]));

  await Promise.all(userIds.map(async (id) => {
    const sid = String(id);
    const items = byUser.get(sid);

    const [planTasks, dlTasks, events] = await Promise.all([
      searchTasks({ responsibleId: id, '>=startDatePlan': range.from, '<=startDatePlan': range.to }),
      searchTasks({ responsibleId: id, '>=deadline': range.from, '<=deadline': range.to }),
      loadUserEvents(id, range),
    ]);

    // Задачи: объединяем два набора и убираем дубли по id.
    const taskMap = new Map();
    for (const t of [...planTasks, ...dlTasks]) {
      const tid = t.id != null ? t.id : t.ID;
      if (tid != null) taskMap.set(String(tid), t);
    }
    for (const t of taskMap.values()) {
      const item = mapTask(t, sid);
      if (item) items.push(item);
    }

    for (const e of events) {
      const item = mapEvent(e, sid);
      if (item) items.push(item);
    }
  }));

  await enrichTodayLogged(byUser);
  return byUser;
}

async function searchTasks(filter) {
  try {
    const data = await apiSend('/tasks/search', 'POST', {
      filter, select: TASK_SELECT, limit: 200,
    });
    return asArray(data);
  } catch (e) {
    console.warn('Не удалось загрузить задачи:', e);
    return [];
  }
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

function mapTask(t, userId) {
  const title = t.title || t.TITLE || 'Без названия';
  const planStart = parseB24Date(t.startDatePlan || t.START_DATE_PLAN);
  const planEnd = parseB24Date(t.endDatePlan || t.END_DATE_PLAN);
  const deadline = parseB24Date(t.deadline || t.DEADLINE);

  let start, end;
  if (planStart && planEnd && planEnd > planStart) {
    start = planStart;
    end = planEnd;
  } else if (deadline) {
    end = deadline;
    start = new Date(deadline.getTime() - GRID.slotMinutes * 60 * 1000);
  } else {
    return null;
  }

  const code = toStatusCode(t.status != null ? t.status : t.STATUS);
  const status = resolveTaskStatus(code, deadline);
  const timeEstimate = Number(t.timeEstimate || t.TIME_ESTIMATE || 0);
  const timeSpent = Number(t.timeSpentInLogs || t.TIME_SPENT_IN_LOGS || 0);

  return {
    id: 'task_' + (t.id || t.ID),
    rawId: String(t.id || t.ID),
    kind: 'task',
    userId,
    title,
    description: t.description || t.DESCRIPTION || '',
    start, end,
    allDay: false,
    status,
    hoursPlan: secondsToHours(timeEstimate),
    hoursFact: secondsToHours(timeSpent),
    hoursToday: 0,
    raw: t,
  };
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

// Заполняет hoursToday для задач (время, залогированное сегодня). Best-effort.
async function enrichTodayLogged(byUser) {
  const todayStart = startOfDay(new Date());
  const todayEnd = addDays(todayStart, 1);

  const taskItems = [];
  for (const items of byUser.values()) {
    for (const it of items) if (it.kind === 'task') taskItems.push(it);
  }
  if (taskItems.length === 0) return;

  await Promise.all(taskItems.map(async (it) => {
    try {
      const rows = asArray(await apiGet('/tasks/' + it.rawId + '/time'));
      let sec = 0;
      for (const r of rows) {
        const created = parseB24Date(r.createdDate || r.CREATED_DATE || r.createdAt);
        if (created && created >= todayStart && created < todayEnd) {
          sec += Number(r.seconds || r.SECONDS || 0);
        }
      }
      it.hoursToday = secondsToHours(sec);
    } catch (e) { /* не критично — оставим 0 */ }
  }));
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

// Привязать существующую задачу к слоту = задать плановые даты.
export async function attachTaskToSlot(rawId, start, end) {
  return apiSend('/tasks/' + rawId, 'PATCH', {
    startDatePlan: toB24DateTime(start),
    endDatePlan: toB24DateTime(end),
  });
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
  return apiSend('/calendar-events', 'POST', {
    type: 'user',
    ownerId: userId,
    name,
    description: description || '',
    dateFrom: toB24DateTime(start),
    dateTo: toB24DateTime(end),
    accessibility: kind === 'absence' ? 'absent' : 'busy',
  });
}

export async function updateEvent(rawId, userId, { name, description, start, end, kind }) {
  const body = { type: 'user', ownerId: userId };
  if (name != null) body.name = name;
  if (description != null) body.description = description;
  if (start) body.dateFrom = toB24DateTime(start);
  if (end) body.dateTo = toB24DateTime(end);
  if (kind) body.accessibility = kind === 'absence' ? 'absent' : 'busy';
  return apiSend('/calendar-events/' + rawId, 'PATCH', body);
}

export { isToday };
