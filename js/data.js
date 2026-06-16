// Доменный слой: загрузка и сохранение сущностей Битрикс24, приведение их к
// единой модели «item», с которой работает календарь.
//
// Единая модель:
//   { id, kind: 'task'|'event'|'absence', userId,
//     title, description, start: Date, end: Date,
//     status, hoursFact, hoursPlan, hoursToday, allDay, raw }

import {
  callMethod, callListMethod, callBatch, getOption, setOption, OPTION_KEYS,
} from './b24.js';
import { GRID, TASK_STATUS } from './config.js';
import {
  parseB24Date, toB24DateTime, weekRangeB24, secondsToHours, isToday,
  startOfDay, addDays,
} from './dates.js';

// --- Сотрудники -----------------------------------------------------------

export async function loadUsers() {
  const rows = await callListMethod('user.get', {
    sort: 'LAST_NAME',
    order: 'ASC',
    FILTER: { ACTIVE: true },
  });
  return rows
    .filter((u) => u && u.ID)
    .map((u) => ({
      id: String(u.ID),
      name: [u.LAST_NAME, u.NAME].filter(Boolean).join(' ').trim() ||
            u.NAME || u.EMAIL || ('ID ' + u.ID),
      position: u.WORK_POSITION || '',
      photo: u.PERSONAL_PHOTO || '',
    }));
}

// --- Настройки приложения -------------------------------------------------

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
  const limited = ids.map(String).slice(0, GRID.maxEmployees);
  await setOption(OPTION_KEYS.selectedUsers, JSON.stringify(limited));
}

// --- Загрузка данных недели ------------------------------------------------

const TASK_SELECT = [
  'ID', 'TITLE', 'STATUS', 'RESPONSIBLE_ID', 'DESCRIPTION',
  'DEADLINE', 'START_DATE_PLAN', 'END_DATE_PLAN',
  'TIME_ESTIMATE', 'TIME_SPENT_IN_LOGS',
];

// Загружает задачи, события и отсутствия для всех сотрудников за неделю.
// Возвращает Map<userId, item[]>.
export async function loadWeekData(userIds, weekDate) {
  const range = weekRangeB24(weekDate);
  const byUser = new Map(userIds.map((id) => [String(id), []]));

  // Формируем батч: на каждого сотрудника — задачи (по плану и по дедлайну)
  // и события календаря.
  const calls = {};
  for (const id of userIds) {
    calls[`task_plan_${id}`] = {
      method: 'tasks.task.list',
      params: {
        filter: {
          RESPONSIBLE_ID: id,
          '>=START_DATE_PLAN': range.from,
          '<=START_DATE_PLAN': range.to,
        },
        select: TASK_SELECT,
      },
    };
    calls[`task_dl_${id}`] = {
      method: 'tasks.task.list',
      params: {
        filter: {
          RESPONSIBLE_ID: id,
          '>=DEADLINE': range.from,
          '<=DEADLINE': range.to,
        },
        select: TASK_SELECT,
      },
    };
    calls[`events_${id}`] = {
      method: 'calendar.event.get',
      params: { type: 'user', ownerId: id, from: range.from, to: range.to },
    };
  }

  const results = await callBatch(calls);

  for (const id of userIds) {
    const sid = String(id);
    const items = byUser.get(sid);

    // Задачи: объединяем два набора и убираем дубли по ID.
    const taskMap = new Map();
    for (const key of [`task_plan_${id}`, `task_dl_${id}`]) {
      const res = results[key];
      const tasks = (res && (res.tasks || res)) || [];
      for (const t of (Array.isArray(tasks) ? tasks : [])) {
        if (t && t.id != null) taskMap.set(String(t.id), t);
        else if (t && t.ID != null) taskMap.set(String(t.ID), t);
      }
    }
    for (const t of taskMap.values()) {
      const item = mapTask(t, sid);
      if (item) items.push(item);
    }

    // События календаря -> события / отсутствия.
    const events = results[`events_${id}`] || [];
    for (const e of (Array.isArray(events) ? events : [])) {
      const item = mapEvent(e, sid);
      if (item) items.push(item);
    }
  }

  // Доводим «часы за сегодня» для видимых задач.
  await enrichTodayLogged(byUser);

  return byUser;
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
    // Без планового интервала — 30-минутный блок, заканчивающийся дедлайном.
    end = deadline;
    start = new Date(deadline.getTime() - GRID.slotMinutes * 60 * 1000);
  } else {
    return null; // нечего размещать на сетке
  }

  const statusCode = Number(t.status || t.STATUS);
  const status = resolveTaskStatus(statusCode, deadline);
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
    hoursToday: 0, // заполняется в enrichTodayLogged
    raw: t,
  };
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
  const start = parseB24Date(e.DATE_FROM || e.dateFrom);
  const end = parseB24Date(e.DATE_TO || e.dateTo);
  if (!start || !end) return null;

  const accessibility = (e.ACCESSIBILITY || e.accessibility || '').toLowerCase();
  const isAbsence = accessibility === 'absent';
  const skipTime = (e.SKIP_TIME || e.skipTime) === 'Y';

  return {
    id: (isAbsence ? 'absence_' : 'event_') + (e.ID || e.id),
    rawId: String(e.ID || e.id),
    kind: isAbsence ? 'absence' : 'event',
    userId,
    title: e.NAME || e.name || (isAbsence ? 'Отсутствие' : 'Событие'),
    description: e.DESCRIPTION || e.description || '',
    start, end,
    allDay: skipTime,
    status: null,
    hoursPlan: 0, hoursFact: 0, hoursToday: 0,
    raw: e,
  };
}

// Заполняет hoursToday для задач (время, залогированное сегодня).
async function enrichTodayLogged(byUser) {
  const todayStart = startOfDay(new Date());
  const todayEnd = addDays(todayStart, 1);

  const taskItems = [];
  for (const items of byUser.values()) {
    for (const it of items) if (it.kind === 'task') taskItems.push(it);
  }
  if (taskItems.length === 0) return;

  // Батчим запросы списков затраченного времени порциями по 50.
  const chunks = [];
  for (let i = 0; i < taskItems.length; i += 50) chunks.push(taskItems.slice(i, i + 50));

  for (const chunk of chunks) {
    const calls = {};
    for (const it of chunk) {
      calls['e_' + it.rawId] = {
        method: 'task.elapseditem.getlist',
        params: {
          ORDER: { ID: 'ASC' },
          FILTER: {
            TASK_ID: it.rawId,
            '>=CREATED_DATE': toB24DateTime(todayStart),
            '<CREATED_DATE': toB24DateTime(todayEnd),
          },
        },
      };
    }
    let results;
    try {
      results = await callBatch(calls);
    } catch (e) {
      console.warn('Не удалось получить часы за сегодня:', e);
      return; // не критично — просто оставим 0
    }
    for (const it of chunk) {
      const rows = results['e_' + it.rawId];
      if (!Array.isArray(rows)) continue;
      const sec = rows.reduce((s, r) => s + Number(r.SECONDS || r.seconds || 0), 0);
      it.hoursToday = secondsToHours(sec);
    }
  }
}

// --- Создание и обновление сущностей --------------------------------------

export async function createTask({ title, userId, description, start, end, hoursPlan }) {
  const fields = {
    TITLE: title,
    RESPONSIBLE_ID: userId,
    DESCRIPTION: description || '',
  };
  if (start) fields.START_DATE_PLAN = toB24DateTime(start);
  if (end) {
    fields.END_DATE_PLAN = toB24DateTime(end);
    fields.DEADLINE = toB24DateTime(end);
  }
  if (hoursPlan) fields.TIME_ESTIMATE = Math.round(Number(hoursPlan) * 3600);
  return callMethod('tasks.task.add', { fields });
}

export async function updateTask(rawId, { title, description, start, end, hoursPlan, status }) {
  const fields = {};
  if (title != null) fields.TITLE = title;
  if (description != null) fields.DESCRIPTION = description;
  if (start) fields.START_DATE_PLAN = toB24DateTime(start);
  if (end) {
    fields.END_DATE_PLAN = toB24DateTime(end);
    fields.DEADLINE = toB24DateTime(end);
  }
  if (hoursPlan != null && hoursPlan !== '') fields.TIME_ESTIMATE = Math.round(Number(hoursPlan) * 3600);
  if (status != null) fields.STATUS = status;
  return callMethod('tasks.task.update', { taskId: rawId, fields });
}

// Привязать существующую задачу к слоту = задать плановые даты.
export async function attachTaskToSlot(rawId, start, end) {
  return callMethod('tasks.task.update', {
    taskId: rawId,
    fields: {
      START_DATE_PLAN: toB24DateTime(start),
      END_DATE_PLAN: toB24DateTime(end),
    },
  });
}

// Список задач сотрудника для привязки (активные, не завершённые).
export async function loadUserTasksForPick(userId) {
  const res = await callListMethod('tasks.task.list', {
    filter: { RESPONSIBLE_ID: userId, '<STATUS': 5 },
    select: ['ID', 'TITLE', 'STATUS', 'DEADLINE'],
    order: { ID: 'DESC' },
  }, { resultKey: 'tasks' });
  return (res || []).map((t) => ({
    id: String(t.id || t.ID),
    title: t.title || t.TITLE || 'Без названия',
  }));
}

export async function createEvent({ name, userId, description, start, end, kind }) {
  return callMethod('calendar.event.add', {
    type: 'user',
    ownerId: userId,
    from: toB24DateTime(start),
    to: toB24DateTime(end),
    name,
    description: description || '',
    accessibility: kind === 'absence' ? 'absent' : 'busy',
  });
}

export async function updateEvent(rawId, userId, { name, description, start, end, kind }) {
  const params = { id: rawId, type: 'user', ownerId: userId };
  if (name != null) params.name = name;
  if (description != null) params.description = description;
  if (start) params.from = toB24DateTime(start);
  if (end) params.to = toB24DateTime(end);
  if (kind) params.accessibility = kind === 'absence' ? 'absent' : 'busy';
  return callMethod('calendar.event.update', params);
}

export { isToday };
