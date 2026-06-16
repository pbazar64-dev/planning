// Транспортный слой к Битрикс24.
//
// Один интерфейс — два режима:
//   * 'bx24'    — встраиваемое приложение через глобальный BX24 JS SDK
//                 (подключается в index.html как //api.bitrix24.com/api/v1/).
//   * 'gateway' — standalone через REST-шлюз vibecode с Bearer-ключом.
//
// Наружу отдаём небольшой набор функций: init, callMethod, callListMethod,
// callBatch, getOption, setOption. Весь специфичный для шлюза HTTP-контракт
// сосредоточен здесь — если формат эндпоинта отличается, правится одно место.

import { CONFIG, OPTION_KEYS } from './config.js';

export class B24Error extends Error {
  constructor(message, code, raw) {
    super(message);
    this.name = 'B24Error';
    this.code = code;
    this.raw = raw;
  }
}

const isGateway = () => CONFIG.transport === 'gateway';

// --- Инициализация -------------------------------------------------------

let bx24Ready = null;

export function init() {
  if (isGateway()) return Promise.resolve();
  if (bx24Ready) return bx24Ready;

  bx24Ready = new Promise((resolve, reject) => {
    if (typeof window.BX24 === 'undefined') {
      reject(new B24Error('BX24 JS SDK не загружен. Откройте приложение внутри портала Битрикс24.'));
      return;
    }
    try {
      window.BX24.init(() => resolve());
    } catch (e) {
      reject(new B24Error('Не удалось инициализировать BX24: ' + e.message));
    }
  });
  return bx24Ready;
}

// --- Повторные попытки при сетевых сбоях ----------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry(fn) {
  const { attempts, backoffMs } = CONFIG.retry;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Повторяем только транзиентные ошибки (сеть / 5xx / лимиты).
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
    if (e.code === 'QUERY_LIMIT_EXCEEDED' || e.code === 'OPERATION_TIME_LIMIT') return true;
    return false;
  }
  return true; // неизвестные ошибки считаем транзиентными
}

// --- Низкоуровневый вызов одного метода -----------------------------------

// Возвращает «сырой» ответ: { result, total, next, error, error_description }.
function rawCall(method, params) {
  return isGateway() ? gatewayCall(method, params) : bx24Call(method, params);
}

function bx24Call(method, params) {
  return new Promise((resolve, reject) => {
    window.BX24.callMethod(method, params || {}, (res) => {
      const err = res.error();
      if (err) {
        const code = (err.ex && err.ex.error) || err.error || 'ERROR';
        const desc = (err.ex && err.ex.error_description) ||
                     err.error_description || String(err);
        reject(new B24Error(desc, code, err));
        return;
      }
      resolve({
        result: res.data(),
        total: res.total ? res.total() : undefined,
        // res.more()/res.next() обрабатываются в callListMethod
        _res: res,
      });
    });
  });
}

async function gatewayCall(method, params) {
  const { baseUrl, callPath, accessKey } = CONFIG.gateway;
  let resp;
  try {
    resp = await fetch(baseUrl + callPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + accessKey,
      },
      body: JSON.stringify({ method, params: params || {} }),
    });
  } catch (e) {
    throw new B24Error('Сетевая ошибка: ' + e.message, 'NETWORK', e);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new B24Error(`HTTP ${resp.status}: ${text || resp.statusText}`, resp.status);
  }
  const json = await resp.json().catch(() => ({}));
  if (json.error) {
    throw new B24Error(json.error_description || json.error, json.error, json);
  }
  return { result: json.result, total: json.total, next: json.next };
}

// Один вызов с ретраями. Возвращает result (массив/объект/значение).
export async function callMethod(method, params) {
  const raw = await withRetry(() => rawCall(method, params));
  return raw.result;
}

// --- Списочный вызов с прокруткой страниц ----------------------------------
// Собирает все страницы (user.get, tasks.task.list, calendar.event.get, ...).

export async function callListMethod(method, params, { resultKey } = {}) {
  if (isGateway()) return gatewayList(method, params, resultKey);
  return bx24List(method, params, resultKey);
}

function extractItems(result, resultKey) {
  if (resultKey && result && typeof result === 'object') return result[resultKey] || [];
  return Array.isArray(result) ? result : (result ? [result] : []);
}

function bx24List(method, params, resultKey) {
  return withRetry(() => new Promise((resolve, reject) => {
    const acc = [];
    window.BX24.callMethod(method, params || {}, function handler(res) {
      const err = res.error();
      if (err) {
        const code = (err.ex && err.ex.error) || err.error || 'ERROR';
        const desc = (err.ex && err.ex.error_description) || err.error_description || String(err);
        reject(new B24Error(desc, code, err));
        return;
      }
      acc.push(...extractItems(res.data(), resultKey));
      if (res.more && res.more()) {
        res.next(); // вызовет handler снова со следующей страницей
      } else {
        resolve(acc);
      }
    });
  }));
}

async function gatewayList(method, params, resultKey) {
  const acc = [];
  let start = 0;
  // Защита от бесконечного цикла.
  for (let guard = 0; guard < 1000; guard++) {
    const p = { ...(params || {}), start };
    const raw = await withRetry(() => gatewayCall(method, p));
    acc.push(...extractItems(raw.result, resultKey));
    if (raw.next === undefined || raw.next === null) break;
    start = raw.next;
  }
  return acc;
}

// --- Батч-вызовы ----------------------------------------------------------
// calls: { key: { method, params } }. Возвращает { key: result }.

export async function callBatch(calls) {
  return isGateway() ? gatewayBatch(calls) : bx24Batch(calls);
}

function bx24Batch(calls) {
  return withRetry(() => new Promise((resolve, reject) => {
    const payload = {};
    for (const [key, { method, params }] of Object.entries(calls)) {
      payload[key] = [method, params || {}];
    }
    window.BX24.callBatch(payload, (results) => {
      const out = {};
      for (const key of Object.keys(calls)) {
        const res = results[key];
        if (!res) { out[key] = null; continue; }
        if (res.error && res.error()) {
          // Не валим весь батч из-за одной ошибки — отдаём null и логируем.
          console.warn(`Батч-вызов «${key}» завершился ошибкой:`, res.error());
          out[key] = null;
        } else {
          out[key] = res.data();
        }
      }
      resolve(out);
    }, false);
  }));
}

async function gatewayBatch(calls) {
  const { baseUrl, batchPath, accessKey } = CONFIG.gateway;
  const cmd = {};
  for (const [key, { method, params }] of Object.entries(calls)) {
    const qs = new URLSearchParams(flatten(params || {})).toString();
    cmd[key] = `${method}?${qs}`;
  }
  const raw = await withRetry(async () => {
    let resp;
    try {
      resp = await fetch(baseUrl + batchPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessKey },
        body: JSON.stringify({ halt: 0, cmd }),
      });
    } catch (e) {
      throw new B24Error('Сетевая ошибка: ' + e.message, 'NETWORK', e);
    }
    if (!resp.ok) throw new B24Error(`HTTP ${resp.status}`, resp.status);
    return resp.json();
  });
  const result = (raw.result && raw.result.result) || raw.result || {};
  return result;
}

// Плоская сериализация параметров для query-строки батча.
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

// --- Настройки приложения (на стороне портала) ----------------------------
// В режиме bx24 используем BX24.appOption (общие для приложения настройки).
// В режиме gateway — REST-методы app.option.get / app.option.set.

export async function getOption(key, fallback = null) {
  try {
    if (isGateway()) {
      const res = await callMethod('app.option.get', {});
      const val = res && res[key];
      return val !== undefined && val !== null ? val : fallback;
    }
    const val = window.BX24.appOption.get(key);
    return val !== undefined && val !== null && val !== '' ? val : fallback;
  } catch (e) {
    console.warn('Не удалось прочитать настройку', key, e);
    return fallback;
  }
}

export async function setOption(key, value) {
  if (isGateway()) {
    await callMethod('app.option.set', { options: { [key]: value } });
    return;
  }
  await new Promise((resolve, reject) => {
    try {
      window.BX24.appOption.set(key, value, () => resolve());
    } catch (e) {
      reject(new B24Error('Не удалось сохранить настройку: ' + e.message));
    }
  });
}

export { OPTION_KEYS };
