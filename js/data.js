// Доменный слой: загрузка и сохранение сущностей Битрикс24, приведение их к
// единой модели «item», с которой работает календарь.
//
// Единая модель:
//   { id, rawId, kind: 'task'|'event'|'absence', userId,
//     title, description, start: Date, end: Date,
//     status, hoursFact, hoursPlan, hoursToday, allDay,
//     slot: { eventId, ownerId } | null,   // ячейка-слот работы над задачей
//     recurring, recurrenceLabel, raw }
//
// Одна задача Б24 может занимать несколько ячеек: кроме плановых дат задачи
// работа над ней планируется «слотами» — событиями календаря с меткой
// [task#ID] (в т.ч. повторяющимися). В Б24 при этом задача остаётся одна.

import {
  callMethod, callListMethod, callBatch, getOption, setOption, OPTION_KEYS,
} from './b24.js';
import { GRID, TASK_STATUS, COLORS } from './config.js';
import {
  parseB24Date, toB24DateTime, weekRangeB24, secondsToHours, isToday,
  startOfDay, addDays,
} from './dates.js';
import {
  isRecurring, toB24RRule, parseB24RRule, expandOccurrences, describeB24RRule,
} from './recurrence.js';

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

  // Задачи по всем сотрудникам (для слотов могут понадобиться «чужие» недели).
  const tasksById = new Map();
  const tasksByUser = new Map();
  const slotsByUser = new Map();
  const missingTaskIds = new Set();

  for (const id of userIds) {
    const sid = String(id);

    // Задачи: объединяем два набора и убираем дубли по ID.
    const own = new Map();
    for (const key of [`task_plan_${id}`, `task_dl_${id}`]) {
      const res = results[key];
      const tasks = (res && (res.tasks || res)) || [];
      for (const t of (Array.isArray(tasks) ? tasks : [])) {
        const tid = t && (t.id != null ? t.id : t.ID);
        if (tid == null) continue;
        own.set(String(tid), t);
        tasksById.set(String(tid), t);
      }
    }
    tasksByUser.set(sid, own);

    // События календаря: слоты задач отдельно, остальное — встречи/отсутствия.
    const slots = [];
    const events = results[`events_${id}`] || [];
    for (const inst of expandEventInstances(Array.isArray(events) ? events : [], range)) {
      const taskId = slotTaskId(inst.event);
      if (taskId) {
        slots.push({ ...inst, taskId });
        if (!tasksById.has(taskId)) missingTaskIds.add(taskId);
      } else {
        const item = mapEvent(inst, sid);
        if (item) byUser.get(sid).push(item);
      }
    }
    slotsByUser.set(sid, slots);
  }

  // Догружаем задачи, на которые ссылаются слоты, но которых нет в выборке недели.
  if (missingTaskIds.size > 0) {
    try {
      const rows = await callListMethod('tasks.task.list', {
        filter: { ID: [...missingTaskIds] },
        select: TASK_SELECT,
      }, { resultKey: 'tasks' });
      for (const t of rows || []) {
        const tid = t && (t.id != null ? t.id : t.ID);
        if (tid != null) tasksById.set(String(tid), t);
      }
    } catch (e) {
      console.warn('Не удалось загрузить задачи слотов:', e);
    }
  }

  for (const id of userIds) {
    const sid = String(id);
    const items = byUser.get(sid);
    const slots = slotsByUser.get(sid);

    // Слоты работы над задачей — отдельные ячейки одной и той же задачи.
    const slotted = new Set();
    for (const slot of slots) {
      const task = tasksById.get(slot.taskId);
      if (!task) {
        // Задача удалена или недоступна — показываем слот как обычное событие.
        const item = mapEvent(slot, sid);
        if (item) items.push(item);
        continue;
      }
      items.push(mapTaskSlot(task, slot, sid));
      slotted.add(slot.taskId);
    }

    // Сама задача по плановым датам/дедлайну — только если на этой неделе у неё
    // нет слотов (иначе это был бы дубль той же работы).
    for (const [tid, t] of tasksByUser.get(sid)) {
      if (slotted.has(tid)) continue;
      const item = mapTask(t, sid);
      if (item) items.push(item);
    }
  }

  // Доводим «часы за сегодня» для видимых задач.
  await enrichTodayLogged(byUser);

  return byUser;
}

function mapTask(t, userId) {
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

  return {
    ...taskInfo(t),
    id: 'task_' + (t.id || t.ID),
    userId,
    start, end,
    allDay: false,
    slot: null,
    recurring: false,
    recurrenceLabel: '',
    raw: t,
  };
}

// Ячейка «слота» — запланированная работа над задачей (событие календаря).
function mapTaskSlot(t, inst, userId) {
  const e = inst.event;
  const eventId = String(e.ID || e.id);
  return {
    ...taskInfo(t),
    id: `slot_${eventId}_${inst.start.getTime()}`,
    userId,
    start: inst.start,
    end: inst.end,
    allDay: false,
    slot: { eventId, ownerId: userId },
    recurring: inst.recurring,
    recurrenceLabel: inst.recurring ? describeB24RRule(inst.rrule) : '',
    raw: t,
  };
}

// Общие поля задачи для обычной ячейки и для слота.
function taskInfo(t) {
  const deadline = parseB24Date(t.deadline || t.DEADLINE);
  const statusCode = Number(t.status || t.STATUS);
  const timeEstimate = Number(t.timeEstimate || t.TIME_ESTIMATE || 0);
  const timeSpent = Number(t.timeSpentInLogs || t.TIME_SPENT_IN_LOGS || 0);
  return {
    rawId: String(t.id || t.ID),
    kind: 'task',
    title: t.title || t.TITLE || 'Без названия',
    description: t.description || t.DESCRIPTION || '',
    deadline,
    status: resolveTaskStatus(statusCode, deadline),
    hoursPlan: secondsToHours(timeEstimate),
    hoursFact: secondsToHours(timeSpent),
    hoursToday: 0, // заполняется в enrichTodayLogged
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

// Раскладывает события календаря на вхождения недели:
// [{ event, start, end, recurring, rrule }].
// Повторяющиеся события портал обычно отдаёт уже развёрнутыми (у вхождений
// есть поле RINDEX); если пришёл только «родитель» серии — разворачиваем сами.
function expandEventInstances(events, range) {
  const expandedIds = new Set(events
    .filter((e) => e.RINDEX != null && e.RINDEX !== '')
    .map((e) => String(e.ID || e.id)));

  const out = [];
  const seen = new Set();
  const push = (e, start, end, rrule) => {
    const key = String(e.ID || e.id) + '|' + start.getTime();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ event: e, start, end, recurring: !!rrule, rrule });
  };

  for (const e of events) {
    const start = parseB24Date(e.DATE_FROM || e.dateFrom);
    let end = parseB24Date(e.DATE_TO || e.dateTo);
    if (!start || !end) continue;
    // У событий «на весь день» DATE_TO — начало последнего дня.
    if (isAllDay(e) && end <= start) end = addDays(start, 1);
    else if (isAllDay(e)) end = addDays(startOfDay(end), 1);

    const rrule = eventRRule(e);
    const rule = rrule ? parseB24RRule(rrule) : null;
    const inWeek = end > range.fromDate && start <= range.toDate;
    if (!rule || expandedIds.has(String(e.ID || e.id))) {
      if (inWeek) push(e, start, end, rrule);
      continue;
    }
    const exdates = new Set(String(e.EXDATE || '').split(';').filter(Boolean)
      .map((d) => { const x = parseB24Date(d); return x ? startOfDay(x).getTime() : 0; }));
    for (const o of expandOccurrences(rule, start, end, { from: range.fromDate, to: range.toDate })) {
      if (!exdates.has(startOfDay(o.start).getTime())) push(e, o.start, o.end, rrule);
    }
  }
  return out;
}

function isAllDay(e) {
  return (e.SKIP_TIME || e.skipTime) === 'Y';
}

function eventRRule(e) {
  const rr = e.RRULE || e.rrule || '';
  if (!rr) return '';
  if (typeof rr === 'object' && Object.keys(rr).length === 0) return '';
  return rr;
}

function mapEvent(inst, userId) {
  const e = inst.event;
  const accessibility = (e.ACCESSIBILITY || e.accessibility || '').toLowerCase();
  const isAbsence = accessibility === 'absent';
  const recurring = !!inst.recurring;

  return {
    id: (isAbsence ? 'absence_' : 'event_') + (e.ID || e.id) + (recurring ? '_' + inst.start.getTime() : ''),
    rawId: String(e.ID || e.id),
    kind: isAbsence ? 'absence' : 'event',
    userId,
    title: e.NAME || e.name || (isAbsence ? 'Отсутствие' : 'Событие'),
    description: e.DESCRIPTION || e.description || '',
    start: inst.start,
    end: inst.end,
    allDay: isAllDay(e),
    status: null,
    hoursPlan: 0, hoursFact: 0, hoursToday: 0,
    recurring,
    recurrenceLabel: recurring ? describeB24RRule(inst.rrule) : '',
    raw: e,
  };
}

// Заполняет hoursToday для задач (время, залогированное сегодня).
async function enrichTodayLogged(byUser) {
  const todayStart = startOfDay(new Date());
  const todayEnd = addDays(todayStart, 1);

  // Одна задача может быть в нескольких ячейках (слоты) — группируем по ID.
  const byTask = new Map();
  for (const items of byUser.values()) {
    for (const it of items) {
      if (it.kind !== 'task') continue;
      if (!byTask.has(it.rawId)) byTask.set(it.rawId, []);
      byTask.get(it.rawId).push(it);
    }
  }
  const taskIds = [...byTask.keys()];
  if (taskIds.length === 0) return;

  // Батчим запросы списков затраченного времени порциями по 50.
  for (let i = 0; i < taskIds.length; i += 50) {
    const chunk = taskIds.slice(i, i + 50);
    const calls = {};
    for (const tid of chunk) {
      calls['e_' + tid] = {
        method: 'task.elapseditem.getlist',
        params: {
          ORDER: { ID: 'ASC' },
          FILTER: {
            TASK_ID: tid,
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
    for (const tid of chunk) {
      const rows = results['e_' + tid];
      if (!Array.isArray(rows)) continue;
      const sec = rows.reduce((s, r) => s + Number(r.SECONDS || r.seconds || 0), 0);
      for (const it of byTask.get(tid)) it.hoursToday = secondsToHours(sec);
    }
  }
}

// --- Слоты работы над задачей ----------------------------------------------
// Слот — событие в календаре сотрудника с меткой [task#ID] в описании.
// Слот может повторяться (rrule), но задача в Битрикс24 остаётся одной.

const SLOT_MARK_RE = /\[task#(\d+)\]/;

function slotTaskId(e) {
  const m = SLOT_MARK_RE.exec(String(e.DESCRIPTION || e.description || ''));
  return m ? m[1] : null;
}

function slotDescription(taskId) {
  return `Запланированная работа над задачей [task#${taskId}]`;
}

export async function createTaskSlot({ taskId, title, userId, start, end, rule }) {
  const params = {
    type: 'user',
    ownerId: userId,
    from: toB24DateTime(start),
    to: toB24DateTime(end),
    name: title,
    description: slotDescription(taskId),
    accessibility: 'busy',
    color: COLORS.task.border,
  };
  if (isRecurring(rule)) params.rrule = toB24RRule(rule);
  return callMethod('calendar.event.add', params);
}

// rule: undefined — не менять повторение, null/none — убрать, иначе — задать.
export async function updateTaskSlot(eventId, userId, { title, start, end, rule }) {
  const params = { id: eventId, type: 'user', ownerId: userId };
  if (title != null) params.name = title;
  if (start) params.from = toB24DateTime(start);
  if (end) params.to = toB24DateTime(end);
  if (rule !== undefined) params.rrule = isRecurring(rule) ? toB24RRule(rule) : '';
  return callMethod('calendar.event.update', params);
}

export async function deleteCalendarEvent(eventId, userId) {
  return callMethod('calendar.event.delete', { id: eventId, type: 'user', ownerId: userId });
}

// Исходное событие серии (дата первого вхождения и правило повторения).
export async function loadEventSeries(eventId) {
  const e = await callMethod('calendar.event.getbyid', { id: eventId });
  if (!e) throw new Error('Событие не найдено в календаре');
  const start = parseB24Date(e.DATE_FROM);
  const end = parseB24Date(e.DATE_TO);
  return {
    start, end,
    rule: parseB24RRule(eventRRule(e)),
    rrule: eventRRule(e),
    raw: e,
  };
}

// --- Создание и обновление сущностей --------------------------------------

// Создаёт задачу; возвращает её ID.
export async function createTask(payload) {
  const res = await callMethod('tasks.task.add', { fields: taskFields(payload) });
  const t = res && (res.task || res);
  return String(t && (t.id || t.ID));
}

function taskFields({ title, userId, description, start, end, hoursPlan, withDeadline = true }) {
  const fields = {
    TITLE: title,
    RESPONSIBLE_ID: userId,
    DESCRIPTION: description || '',
  };
  if (start) fields.START_DATE_PLAN = toB24DateTime(start);
  if (end) {
    fields.END_DATE_PLAN = toB24DateTime(end);
    if (withDeadline) fields.DEADLINE = toB24DateTime(end);
  }
  if (hoursPlan) fields.TIME_ESTIMATE = Math.round(Number(hoursPlan) * 3600);
  return fields;
}

// Задача с повторяющейся работой: одна задача в Б24 + серия слотов в календаре.
// Плановые даты задачи — первый слот, дедлайн не ставим (серия может быть
// бесконечной; срок при необходимости задаётся в самой задаче).
export async function createTaskWithSchedule(payload, rule) {
  if (!isRecurring(rule)) return createTask(payload);
  const taskId = await createTask({ ...payload, withDeadline: false });
  try {
    await createTaskSlot({ taskId, title: payload.title, userId: payload.userId, start: payload.start, end: payload.end, rule });
  } catch (e) {
    throw new Error(`Задача создана, но не удалось запланировать повторения: ${e.message}`);
  }
  return taskId;
}

export async function updateTask(rawId, { title, description, start, end, hoursPlan, status, withDeadline = true }) {
  const fields = {};
  if (title != null) fields.TITLE = title;
  if (description != null) fields.DESCRIPTION = description;
  if (start) fields.START_DATE_PLAN = toB24DateTime(start);
  if (end) {
    fields.END_DATE_PLAN = toB24DateTime(end);
    if (withDeadline) fields.DEADLINE = toB24DateTime(end);
  }
  if (hoursPlan != null && hoursPlan !== '') fields.TIME_ESTIMATE = Math.round(Number(hoursPlan) * 3600);
  if (status != null) fields.STATUS = status;
  return callMethod('tasks.task.update', { taskId: rawId, fields });
}

// Привязать существующую задачу к слоту = запланировать работу над ней в
// календаре сотрудника (слот, при необходимости повторяющийся). Сама задача
// не меняется, поэтому одну задачу можно поставить в сколько угодно ячеек.
export async function attachTaskToSlot({ taskId, title, userId, start, end, rule }) {
  return createTaskSlot({ taskId, title, userId, start, end, rule });
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

export async function createEvent({ name, userId, description, start, end, kind, rule }) {
  const params = {
    type: 'user',
    ownerId: userId,
    from: toB24DateTime(start),
    to: toB24DateTime(end),
    name,
    description: description || '',
    accessibility: kind === 'absence' ? 'absent' : 'busy',
  };
  // Повторение встреч и отсутствий — штатными средствами календаря.
  if (isRecurring(rule)) params.rrule = toB24RRule(rule);
  return callMethod('calendar.event.add', params);
}

// rule: undefined — не менять повторение, null/none — убрать, иначе — задать.
export async function updateEvent(rawId, userId, { name, description, start, end, kind, rule }) {
  const params = { id: rawId, type: 'user', ownerId: userId };
  if (name != null) params.name = name;
  if (description != null) params.description = description;
  if (start) params.from = toB24DateTime(start);
  if (end) params.to = toB24DateTime(end);
  if (kind) params.accessibility = kind === 'absence' ? 'absent' : 'busy';
  if (rule !== undefined) params.rrule = isRecurring(rule) ? toB24RRule(rule) : '';
  return callMethod('calendar.event.update', params);
}

export { isToday };
