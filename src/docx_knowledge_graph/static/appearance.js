'use strict';

window.GraphAppearance = (() => {
  const systemTheme = matchMedia('(prefers-color-scheme: dark)');
  function read(key, fallback) {
    try { return localStorage.getItem(`graph-studio.${key}`) ?? fallback; }
    catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(`graph-studio.${key}`, String(value)); } catch {}
  }
  let preference = read('theme', 'system');
  if (!['system', 'light', 'dark'].includes(preference)) preference = 'system';
  function applyTheme() {
    const theme = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.dispatchEvent(new CustomEvent('graph-theme-change', {detail: theme}));
  }
  function setTheme(value) {
    if (!['system', 'light', 'dark'].includes(value)) return;
    preference = value;
    save('theme', preference);
    applyTheme();
  }
  applyTheme();
  systemTheme.addEventListener('change', () => { if (preference === 'system') applyTheme(); });
  document.addEventListener('DOMContentLoaded', () => {
    const control = document.createElement('select');
    control.id = 'theme-mode';
    control.setAttribute('aria-label', 'Color theme');
    control.title = 'Color theme · follows your system by default';
    for (const [value, label] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) {
      const option = document.createElement('option');
      option.value = value; option.textContent = label; control.append(option);
    }
    document.querySelector('.top-actions').prepend(control);
    control.value = preference;
    control.addEventListener('change', () => setTheme(control.value));
  });
  return {read, save, setTheme};
})();
