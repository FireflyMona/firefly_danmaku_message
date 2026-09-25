const fields = {
  visibility: document.getElementById('visibility'),
  scopeSpecialPrivate: document.getElementById('scopeSpecialPrivate'),
  scopeNormalPrivate: document.getElementById('scopeNormalPrivate'),
  scopeNormalGroup: document.getElementById('scopeNormalGroup'),
  wechatPrivate: document.getElementById('wechatPrivate'),
  wechatGroup: document.getElementById('wechatGroup'),
  language: document.getElementById('language'),
  wsUrl: document.getElementById('wsUrl'),
  token: document.getElementById('token'),
  reconnectMs: document.getElementById('reconnectMs'),
  enableWechat: document.getElementById('enableWechat'),
  bannerBgColor: document.getElementById('bannerBgColor'),
  bannerLabelColor: document.getElementById('bannerLabelColor'),
  bannerNickColor: document.getElementById('bannerNickColor'),
  bannerTextColor: document.getElementById('bannerTextColor'),
  fontSize: document.getElementById('fontSize'),
  opacity: document.getElementById('opacity'),
  widthPercent: document.getElementById('widthPercent'),
  maxHeightPercent: document.getElementById('maxHeightPercent'),
  secondsPerLine: document.getElementById('secondsPerLine'),
  maxBannerCount: document.getElementById('maxBannerCount')
};
const qqConnEl = document.getElementById('qqConn');
const wechatConnEl = document.getElementById('wechatConn');
const qqAccountEl = document.getElementById('qqAccount');
const wechatAccountEl = document.getElementById('wechatAccount');
const savedToast = document.getElementById('savedToast');
const resetBtn = document.getElementById('reset');
const saveBtn = document.getElementById('save');

let current = null;
let savedTimer = null;

function fill(s) {
  if (!s) return;
  current = s;
  fields.scopeSpecialPrivate.checked = s.scopeSpecialPrivate !== false;
  fields.scopeNormalPrivate.checked = s.scopeNormalPrivate !== false;
  fields.scopeNormalGroup.checked = s.scopeNormalGroup !== false;
  fields.wechatPrivate.checked = s.wechatPrivate !== false;
  fields.wechatGroup.checked = s.wechatGroup !== false;
  fields.language.value = s.language === 'en' ? 'en' : 'zh';
  fields.wsUrl.value = s.wsUrl;
  fields.token.value = s.token || '';
  fields.reconnectMs.value = s.reconnectMs;
  fields.enableWechat.checked = !!s.enableWechat;
  fields.bannerBgColor.value = s.bannerBgColor || '#ffffff';
  fields.bannerLabelColor.value = s.bannerLabelColor || '#0a7cff';
  fields.bannerNickColor.value = s.bannerNickColor || '#ff6b00';
  fields.bannerTextColor.value = s.bannerTextColor || '#000000';
  fields.fontSize.value = s.fontSize;
  fields.opacity.value = s.opacity;
  fields.widthPercent.value = s.widthPercent;
  fields.maxHeightPercent.value = s.maxHeightPercent;
  fields.secondsPerLine.value = s.secondsPerLine;
  fields.maxBannerCount.value = s.maxBannerCount || 0;
}

function read() {
  if (!current) return null;
  return {
    wsUrl: fields.wsUrl.value.trim() || 'ws://127.0.0.1:3001',
    token: fields.token.value,
    reconnectMs: Number(fields.reconnectMs.value) || 3000,
    scopeSpecialPrivate: fields.scopeSpecialPrivate.checked,
    scopeNormalPrivate: fields.scopeNormalPrivate.checked,
    scopeNormalGroup: fields.scopeNormalGroup.checked,
    wechatPrivate: fields.wechatPrivate.checked,
    wechatGroup: fields.wechatGroup.checked,
    maxBannerCount: Number(fields.maxBannerCount.value) || 0,
    bannerBgColor: fields.bannerBgColor.value,
    bannerLabelColor: fields.bannerLabelColor.value,
    bannerNickColor: fields.bannerNickColor.value,
    bannerTextColor: fields.bannerTextColor.value,
    maxHeightPercent: Number(fields.maxHeightPercent.value) || 25,
    fontSize: Number(fields.fontSize.value) || 16,
    opacity: Number(fields.opacity.value) || 0.92,
    widthPercent: Number(fields.widthPercent.value) || 33,
    secondsPerLine: Number(fields.secondsPerLine.value) || 5,
    enableWechat: fields.enableWechat.checked,
    language: fields.language.value === 'en' ? 'en' : 'zh'
  };
}

async function persist() {
  const next = read();
  if (!next || !window.api || !window.api.saveSettings) return;
  current = await window.api.saveSettings(next);
}

function showSaved() {
  savedToast.classList.remove('hidden');
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(function () { savedToast.classList.add('hidden'); }, 2000);
}

// 显示/隐藏弹幕（独立状态）
if (window.api && window.api.trayGetVisibility) {
  window.api.trayGetVisibility().then(function (v) { fields.visibility.checked = v !== false; });
}
fields.visibility.addEventListener('change', async function () {
  if (!window.api || !window.api.trayToggle) return;
  await window.api.trayToggle();
});

// 勾选/数字/颜色/连接字段变更后即时保存
[
  'scopeSpecialPrivate', 'scopeNormalPrivate', 'scopeNormalGroup',
  'wechatPrivate', 'wechatGroup',
  'wsUrl', 'token', 'reconnectMs', 'enableWechat',
  'bannerBgColor', 'bannerLabelColor', 'bannerNickColor', 'bannerTextColor',
  'fontSize', 'opacity', 'widthPercent', 'maxHeightPercent', 'secondsPerLine', 'maxBannerCount'
].forEach(function (key) {
  fields[key].addEventListener('change', persist);
});

// 语言切换
fields.language.addEventListener('change', async function () {
  const lang = fields.language.value === 'en' ? 'en' : 'zh';
  if (current) current.language = lang;
  if (window.api && window.api.setLanguage) await window.api.setLanguage(lang);
  await window.__setLang(lang);
  await persist();
});

resetBtn.addEventListener('click', async function () {
  if (!window.api || !window.api.resetSettings) return;
  current = await window.api.resetSettings();
  fill(current);
});

saveBtn.addEventListener('click', async function () {
  await persist();
  showSaved();
});

// 连接状态与账号信息
if (window.api && window.api.onConnectionState) {
  window.api.onConnectionState(function (state) {
    qqConnEl.textContent = state.message || '';
    qqConnEl.classList.toggle('on', state.connected);
  });
}
if (window.api && window.api.onQqAccount) {
  window.api.onQqAccount(function (info) {
    if (!info || !info.userId) { qqAccountEl.hidden = true; return; }
    qqAccountEl.hidden = false;
    qqAccountEl.textContent = window.__t('console.qqAccount', { id: info.userId, name: info.nickname || '' });
  });
}
if (window.api && window.api.onWechatState) {
  window.api.onWechatState(function (info) {
    wechatConnEl.textContent = info.message || '';
    wechatConnEl.classList.toggle('on', !!info.loggedIn);
    if (info && info.loggedIn && info.selfWxid) {
      wechatAccountEl.hidden = false;
      wechatAccountEl.textContent = window.__t('console.wechatAccount', { id: info.selfWxid, name: info.nickname || '' });
    } else {
      wechatAccountEl.hidden = true;
    }
  });
}

window.__i18nReady.then(async function () {
  if (!window.api || !window.api.getSettings) return;
  const s = await window.api.getSettings();
  fill(s);
});
