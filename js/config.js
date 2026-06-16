// Конфигурация приложения-планировщика для Битрикс24.
//
// Приложение встраивается в портал Битрикс24 как placement-приложение и
// работает через BX24 JS SDK (см. js/b24.js). Авторизация выполняется самим
// порталом в рамках iframe — отдельный ключ при этом не требуется.
//
// Если же вы хотите запускать приложение как standalone и обращаться к шлюзу
// vibecode (https://vibecode.bitrix24.tech), включите режим GATEWAY ниже и
// укажите ключ. Весь сетевой контракт шлюза сосредоточен в js/b24.js, чтобы
// при необходимости его было легко поправить в одном месте.

export const CONFIG = {
  // 'bx24'    — встраиваемое приложение (BX24 JS SDK). Режим по умолчанию.
  // 'gateway' — standalone-режим через шлюз vibecode с Bearer-ключом.
  transport: 'bx24',

  gateway: {
    baseUrl: 'https://vibecode.bitrix24.tech',
    // Ключ доступа выдаётся в портале Битрикс24 (раздел Вайбкод).
    // ВНИМАНИЕ: это секрет — не публикуйте его в открытых репозиториях.
    accessKey: 'vibe_app_local_6a31460e09cd47_92314079_Ly1fiSDLl3I0qXAlchUuD37a0a7kTtPnNtrp0yj6rmO7ZvuT2i_e30907',
    callPath: '/v1/call',   // POST { method, params } -> { result, error, ... }
    batchPath: '/v1/batch', // POST { halt, cmd } -> { result, error, ... }
  },

  // Сетевые повторы при временных сбоях.
  retry: {
    attempts: 4,
    backoffMs: [2000, 4000, 8000, 16000],
  },
};

// Параметры сетки календаря.
export const GRID = {
  workStartHour: 8,   // начало рабочей сетки
  workEndHour: 18,    // конец рабочей сетки
  slotMinutes: 30,    // шаг планирования
  slotHeightPx: 50,   // высота 30-минутного слота
  daysPerWeek: 5,     // ПН–ПТ
  maxEmployees: 5,    // максимум одновременно выбранных сотрудников
};

// Ключи для хранения настроек приложения (на стороне портала Битрикс24).
export const OPTION_KEYS = {
  selectedUsers: 'planner_selected_users',
};

// Цветовая схема сущностей.
export const COLORS = {
  task: { bg: '#BBDEFB', border: '#64B5F6' },
  event: { bg: '#C8E6C9', border: '#81C784' },
  absence: { bg: '#E0E0E0', border: '#BDBDBD' },
};

// Статусы задач Битрикс24 (tasks.task STATUS) -> человекочитаемое + иконка.
// 2 — ждёт выполнения, 3 — выполняется, 4 — почти завершена, 5 — завершена,
// 6 — отложена, 7 — отклонена. «Просрочена» вычисляется по дедлайну.
export const TASK_STATUS = {
  pending:   { code: 2, label: 'Ждёт выполнения', icon: '⏳' },
  inProgress:{ code: 3, label: 'Выполняется',     icon: '▶' },
  deferred:  { code: 6, label: 'Отложена',         icon: '⏸' },
  completed: { code: 5, label: 'Завершена',        icon: '✓' },
  overdue:   { code: -1, label: 'Просрочена',      icon: '⚠' },
};
