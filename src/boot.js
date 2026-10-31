// Applies the saved theme before first paint to avoid a flash.
(function () {
  try {
    var m = localStorage.getItem('lx.theme') || 'dark';
    var t = m === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : m;
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* ignore */ }
})();
