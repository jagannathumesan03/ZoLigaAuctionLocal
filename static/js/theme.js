(function initializeTheme() {
  const storageKey = 'football-auction-theme';
  const savedTheme = localStorage.getItem(storageKey);
  const preferredTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(storageKey, theme);
    const toggle = document.getElementById('themeToggle');
    if (!toggle) return;
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    toggle.classList.toggle('is-on', theme === 'light');
    toggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
    toggle.setAttribute('title', `Switch to ${nextTheme} theme`);
    toggle.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
  }

  applyTheme(savedTheme || preferredTheme);

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(document.documentElement.dataset.theme || savedTheme || preferredTheme);
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
      toggle.addEventListener('click', () => {
        applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      });
    }
  });
})();

(function initializeFullscreen() {
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function enterFullscreen() {
    const root = document.documentElement;
    if (root.requestFullscreen) return root.requestFullscreen();
    if (root.webkitRequestFullscreen) return root.webkitRequestFullscreen();
  }

  function exitFullscreen() {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  }

  function syncButton(button) {
    const on = isFullscreen();
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    button.setAttribute('title', on ? 'Exit full screen' : 'Full screen');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('fullscreenToggle');
    if (!button) return;
    const root = document.documentElement;
    if (!root.requestFullscreen && !root.webkitRequestFullscreen) {
      button.hidden = true;
      return;
    }
    button.addEventListener('click', () => {
      if (isFullscreen()) exitFullscreen();
      else enterFullscreen();
    });
    document.addEventListener('fullscreenchange', () => syncButton(button));
    document.addEventListener('webkitfullscreenchange', () => syncButton(button));
    syncButton(button);
  });
})();
