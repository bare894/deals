// Google Analytics 4 (gtag.js), loaded by index.html on every page.
// Kept out of index.html because the CSP forbids inline scripts. Skipped on localhost so
// development traffic stays out of the reports (gtag() then just queues into dataLayer).
// The SPA sends page_view itself after each route renders (trackPageView in app.js), so the
// automatic page_view on load is turned off.
(() => {
  const MEASUREMENT_ID = 'G-BSMZRCKB6Y';
  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(s);
  window.gtag('js', new Date());
  window.gtag('config', MEASUREMENT_ID, { send_page_view: false });
})();
