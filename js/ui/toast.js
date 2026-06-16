// Всплывающие уведомления (понятные сообщения об ошибках/успехе).

let container;

function ensureContainer() {
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message, type = 'info', timeout = 4000) {
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  ensureContainer().appendChild(el);
  // запуск анимации появления
  requestAnimationFrame(() => el.classList.add('toast--visible'));
  const remove = () => {
    el.classList.remove('toast--visible');
    setTimeout(() => el.remove(), 250);
  };
  el.addEventListener('click', remove);
  if (timeout) setTimeout(remove, timeout);
}

export function showError(err) {
  const msg = err && err.message ? err.message : String(err);
  showToast(msg, 'error', 6000);
}
