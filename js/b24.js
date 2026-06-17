// Транспортный слой к REST Битрикс24 через собственный BFF.
//
// Схема vibecode: шлюз авторизует пользователя портала и на пути «шлюз ->
// сервер приложения» подставляет заголовок сессии. Браузер токен не видит,
// поэтому фронтенд обращается к нашему бэкенду `/api/v1/*` (server/bff.py),
// а тот уже проксирует на REST vibecode (`/v1/*`) с этой сессией.
//
// Наружу отдаём: init, apiGet, apiSend, getOption, setOption, OPTION_KEYS.

import { CONFIG, OPTION_KEYS } from './config.js';

export class B24Error extends Error {
  constructor(message, code, raw) {
    super(message);
    this.name = 'B24Error';
    this.code = code;
    this.raw = raw;
  }
}

// --- Инициализация: проверяем, что шлюз отдал сессию --------------------

let ready = null;

export function init() {
  if (ready) return ready;
  ready = (async () => {
    let resp;
    try {
      resp = await fetch('/api/whoami', { credentials: 'same-origin' });
    } catch (e) {
      throw new B24Error('Сетевая ошибка при обращении к серверу приложения: ' + e.message, 'NETWORK', e);
    }
    const json = await resp.json().catch(() => ({}));
    if (!json.hasSession) {
      throw new B24Error('Сессия портала не получена. Откройте приложение внутри портала Битрикс24.', 'NO_SESSION');
    }
  })();
  return ready;
}

// --- Повторные попытки при сетевых сбоях ----------------------------------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function withRetry(fn) {
  const { attempts, backoffMs } = CONFIG.retry;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || i === attempts - 1) throw e;
      await sleep(backoffMs[Math.min(i, backoffMs.length - 1)]);
    }
  }
  throw lastErr;
}

function isTransient(e) {
  if (e instanceof B24Error) {
    if (e.code === 'NETWORK') return true;
    if (typeof e.code === 'number' && e.code >= 500) return true;
    if (e.code === 429 || e.code === 'QUERY_LIMIT_EXCEEDED' || e.code === 'OPERATION_TIME_LIMIT') return true;
    return false;
  }
  return true;
}

// --- Базовый запрос к BFF -------------------------------------------------

// Ответ vibecode: { success, data, total, meta } либо { success:false, error }.
async function request(path, { method = 'GET', query, body } = {}) {
  let url = CONFIG.apiBase + path;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += (path.includes('?') ? '&' : '?') + qs;
  }
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch (e) {
    throw new B24Error('Сетевая ошибка: ' + e.message, 'NETWORK', e);
  }
  let json;
  try { json = await resp.json(); } catch { json = null; }
  if (!resp.ok || (json && json.success === false)) {
    const err = (json && json.error) || {};
    throw new B24Error(err.message || ('HTTP ' + resp.status), err.code || resp.status, json);
  }
  return json || {};
}

// GET-запрос: возвращает массив data (списки) или объект data.
export async function apiGet(path, query) {
  const json = await withRetry(() => request(path, { method: 'GET', query }));
  return json.data !== undefined ? json.data : json;
}

// POST/PATCH/DELETE с телом. Возвращает data.
export async function apiSend(path, method, body) {
  const json = await withRetry(() => request(path, { method, body }));
  return json.data !== undefined ? json.data : json;
}

// --- Настройки (выбор сотрудников) ----------------------------------------
// Хранятся локально в браузере: токена для серверного хранилища у фронта нет,
// а выбор по умолчанию — это пользовательское предпочтение на рабочем месте.

export async function getOption(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v !== null && v !== '' ? v : fallback;
  } catch {
    return fallback;
  }
}

export async function setOption(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* приватный режим — игнорируем */ }
}

export { OPTION_KEYS };
