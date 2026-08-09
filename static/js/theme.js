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
    toggle.textContent = nextTheme === 'light' ? 'Light theme' : 'Dark theme';
    toggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
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
