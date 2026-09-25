const stack = document.getElementById('stack');
const measureStage = document.getElementById('measureStage');

function createBanner(item) {
  const el = document.createElement('div');
  el.className = 'banner';
  if (item.special) el.classList.add('special');
  el.dataset.id = item.id;
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = item.label || window.__t(item.kind === 'private' ? 'common.private' : 'common.group');
  const body = document.createElement('div');
  body.className = 'body';
  const avatar = document.createElement('img');
  avatar.className = 'avatar';
  avatar.src = item.avatar || '';
  avatar.onerror = function () { avatar.style.visibility = 'hidden'; };
  const msg = document.createElement('div');
  msg.className = 'msg';
  const nick = document.createElement('span');
  nick.className = 'nick';
  nick.textContent = (item.nickname || '') + '：';
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = item.text || '';
  msg.appendChild(nick);
  msg.appendChild(text);
  body.appendChild(avatar);
  body.appendChild(msg);
  el.appendChild(label);
  el.appendChild(body);
  return el;
}

window.api.onBannerMeasure(function (item) {
  const el = createBanner(item);
  measureStage.appendChild(el);
  const height = el.offsetHeight || 48;
  measureStage.removeChild(el);
  window.api.reportHeight(item.id, height);
});

window.api.onBannerShow(function (item) {
  const el = createBanner(item);
  stack.appendChild(el);
});

window.api.onBannerRemove(function (id) {
  const el = stack.querySelector('[data-id="' + id + '"]');
  if (!el) return;
  const height = el.offsetHeight || 0;
  const style = el.style;
  style.height = height + 'px';
  style.opacity = '1';
  style.transform = 'translateY(0)';
  style.paddingTop = '8px';
  style.paddingBottom = '8px';
  style.marginTop = '0px';
  style.marginBottom = '0px';
  style.borderTopWidth = '1px';
  style.borderBottomWidth = '1px';
  style.overflow = 'hidden';
  el.classList.add('leaving');
  void el.offsetHeight;
  requestAnimationFrame(function () {
    style.height = '0px';
    style.opacity = '0';
    style.transform = 'translateY(-32px)';
    style.paddingTop = '0px';
    style.paddingBottom = '0px';
    style.marginBottom = '-8px';
    if (el.previousElementSibling) style.marginTop = '-8px';
    style.borderTopWidth = '0px';
    style.borderBottomWidth = '0px';
  });
  setTimeout(function () { el.remove(); }, 800);
});

window.api.onBannerConfig(function (config) {
  document.documentElement.style.setProperty('--banner-font-size', (config.fontSize || 16) + 'px');
  document.documentElement.style.setProperty('--banner-bg-color', config.bgColor || '#ffffff');
  document.documentElement.style.setProperty('--label-color', config.labelColor || '#0a7cff');
  document.documentElement.style.setProperty('--nick-color', config.nickColor || '#ff6b00');
  document.documentElement.style.setProperty('--text-color', config.textColor || '#000000');
});
