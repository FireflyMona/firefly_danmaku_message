const toggleBtn = document.getElementById('toggleBtn');
const uninstallBtn = document.getElementById('uninstallBtn');
const quitBtn = document.getElementById('quitBtn');
const refreshBtn = document.getElementById('refreshBtn');
const consoleBtn = document.getElementById('consoleBtn');
const showText = document.getElementById('showText');
const hideText = document.getElementById('hideText');

function applyVisibility(v) {
  const show = v !== false;
  showText.classList.toggle('blue', show);
  hideText.classList.toggle('blue', !show);
}

if (window.api && window.api.onTrayVisibility) {
  window.api.onTrayVisibility(function (v) { applyVisibility(v); });
}
if (window.api && window.api.trayGetVisibility) {
  window.api.trayGetVisibility().then(applyVisibility).catch(function () { applyVisibility(true); });
}

toggleBtn.addEventListener('click', async function () {
  if (!window.api || !window.api.trayToggle) return;
  const v = await window.api.trayToggle();
  applyVisibility(v);
});

consoleBtn.addEventListener('click', async function () {
  if (!window.api || !window.api.trayOpenConsole) return;
  await window.api.trayOpenConsole();
});

refreshBtn.addEventListener('click', async function () {
  if (!window.api || !window.api.trayRefresh) return;
  await window.api.trayRefresh();
});

uninstallBtn.addEventListener('click', async function () {
  if (!window.api || !window.api.trayUninstallOpen) return;
  await window.api.trayUninstallOpen();
});

quitBtn.addEventListener('click', async function () {
  if (!window.api || !window.api.trayQuit) return;
  await window.api.trayQuit();
});
