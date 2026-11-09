// Colour theme: runs in <head> before the page paints, so a saved Light/Dark choice never flashes
// the other theme. The choice is 'light', 'dark' or absent (follow the device). styles.css reads
// <html data-theme>; app.js owns the toggle and keeps this in step.
(function () {
  var t = null;
  try {
    t = localStorage.getItem('theme');
  } catch (e) {
    /* storage blocked: follow the device */
  }
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
})();
