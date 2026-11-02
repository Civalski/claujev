// ClauJev site: language switch and copy buttons, shared by every page.
// The language itself is set by a tiny inline script in <head>, before the page paints.
(function () {
  var root = document.documentElement;

  function setLang(lang) {
    lang = lang === 'en' ? 'en' : 'pt';
    root.setAttribute('data-lang', lang);
    root.lang = lang === 'pt' ? 'pt-BR' : 'en';
    document.querySelectorAll('[data-set-lang]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-set-lang') === lang));
    });
    try { localStorage.setItem('claujev-lang', lang); } catch (e) {}
    document.dispatchEvent(new CustomEvent('claujev:lang', { detail: lang }));
  }

  document.querySelectorAll('[data-set-lang]').forEach(function (btn) {
    btn.addEventListener('click', function () { setLang(btn.getAttribute('data-set-lang')); });
  });

  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    var label = btn.innerHTML;
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.getAttribute('data-copy'));
      if (!target || !navigator.clipboard) return;
      navigator.clipboard.writeText(target.textContent).then(function () {
        btn.textContent = root.getAttribute('data-lang') === 'en' ? 'Copied' : 'Copiado';
        setTimeout(function () { btn.innerHTML = label; }, 1800);
      }, function () {});
    });
  });

  window.ClauJevSite = { lang: function () { return root.getAttribute('data-lang') || 'pt'; } };
  setLang(root.getAttribute('data-lang'));
})();
