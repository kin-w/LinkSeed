(function () {
  try {
    var mode = localStorage.getItem('ed2k.theme') || 'system';
    var dark = mode === 'dark' || (mode !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themeMode = mode;
  } catch (err) { }
})();
