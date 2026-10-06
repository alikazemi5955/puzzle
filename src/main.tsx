/**
 * Stable UI bootstrap.
 *
 * The current repository contains a prebuilt storefront UI whose original React
 * source is not present in src/. Keep that runtime isolated behind a stable
 * loader instead of hard-coding a Vite hash in index.html. This makes `vite
 * build` deterministic and keeps the legacy UI usable until its source is
 * recovered/reconstructed.
 */
const LEGACY_UI_SRC = '/legacy/puzzlekala-ui.js';

function loadStylesheet(href: string) {
  if (document.querySelector(`link[data-puzzlekala-style="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.puzzlekalaStyle = href;
  document.head.appendChild(link);
}

function loadLegacyUi() {
  if (document.querySelector(`script[data-puzzlekala-ui="${LEGACY_UI_SRC}"]`)) return;

  loadStylesheet('/legacy/puzzlekala-ui.css');
  loadStylesheet('/legacy/digikala-patch.css');

  const script = document.createElement('script');
  script.type = 'module';
  script.src = LEGACY_UI_SRC;
  script.dataset.puzzlekalaUi = LEGACY_UI_SRC;
  script.onerror = () => {
    const root = document.getElementById('root');
    if (root) {
      root.innerHTML = '<div dir="rtl" style="padding:32px;font-family:sans-serif">خطا در بارگذاری رابط کاربری پازل کالا.</div>';
    }
  };
  document.body.appendChild(script);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadLegacyUi, { once: true });
} else {
  loadLegacyUi();
}
