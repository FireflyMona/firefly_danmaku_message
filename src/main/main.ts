import {
  app,
  BrowserWindow,
  Tray,
  nativeImage,
  ipcMain,
  shell,
  screen,
  powerMonitor
} from 'electron';
import { execFile, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppSettings, BannerItem, ConnectionState, EnvCheckResult, OB11MessageEvent, OB11NoticeEvent, WechatMessagePayload } from '../shared/types';
import { productName, translate, messages, Language } from '../shared/i18n';
import { defaultSettings, loadSettings, saveSettings } from './config';
import { runEnvChecks } from './env-check';
import { OneBotClient } from './onebot';
import { normalizeMessageEvent, normalizeNoticeEvent, normalizeWechatMessage } from './normalize';
import { BannerScheduler } from './banner-scheduler';
import { QQWindowWatcher } from './qq-window-watcher';
import { WechatWindowWatcher } from './wechat-window-watcher';
import { DisplayPowerWatcher } from './display-power-watcher';
import { NapCatManager } from './napcat-manager';
import { WechatClient, WechatStateInfo } from './wechat';
import { MouseClickWatcher } from './mouse-click-watcher';

const isInstalledApp = fs.existsSync(installMarkerPath());
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
}

// 开机自启动使用 --silent，以低优先级静默驻留托盘。
const silentStart = process.argv.includes('--silent');
if (silentStart) {
  try { os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW); } catch { /* ignore */ }
}

let settings: AppSettings = defaultSettings;
let installerWindow: BrowserWindow | null = null;
let consoleWindow: BrowserWindow | null = null;
let bannerWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayMenuWindow: BrowserWindow | null = null;
let traySubmenuWindow: BrowserWindow | null = null;
let uninstallDialogWindow: BrowserWindow | null = null;
let scheduler: BannerScheduler | null = null;
let onebot: OneBotClient | null = null;
let wechat: WechatClient | null = null;
let bannerVisible = true;
let bannerReady = false;
let quitting = false;
let qqForeground = false;
let wechatForeground = false;
let sessionLocked = false;
let suspended = false;
let displayOff = false;
let lastResumeAt = 0;
const STALE_DROP_TOLERANCE_MS = 30000;
let powerMonitorBound = false;
let displayPowerWatcher: DisplayPowerWatcher | null = null;
let qqWindowWatcher: QQWindowWatcher | null = null;
let wechatWindowWatcher: WechatWindowWatcher | null = null;
let napcatManager: NapCatManager | null = null;
let cachedSelfId = 0;
let normalTrayImage = nativeImage.createEmpty();
let mouseClickWatcher: MouseClickWatcher | null = null;

function installMarkerPath(): string {
  return path.join(installDir(), '.installed.json');
}

function installDir(): string {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Programs', '流萤QQ弹窗显示');
}

function rendererFile(name: string): string {
  return path.join(__dirname, '..', '..', 'renderer', name);
}

function estimateContentLines(text: string, s: AppSettings): number {
  const width = Math.max(200, Math.round((screen.getPrimaryDisplay().workArea.width * s.widthPercent) / 100));
  const contentWidth = Math.max(80, width - 90);
  const charsPerLine = Math.max(4, Math.floor(contentWidth / Math.max(10, s.fontSize)));
  const lines = Math.ceil((text || '').length / charsPerLine);
  return Math.max(1, Math.min(2, lines));
}

function durationFor(item: BannerItem): number {
  const s = settings;
  const contentLines = estimateContentLines(item.text, s);
  return Math.max(1000, s.secondsPerLine * 1000 * contentLines);
}

function isSystemInactive(): boolean {
  return sessionLocked || suspended || displayOff;
}

function shouldDropStaleMessage(msgTimeMs: number): boolean {
  if (lastResumeAt <= 0 || !Number.isFinite(msgTimeMs) || msgTimeMs <= 0) return false;
  return msgTimeMs <= lastResumeAt - STALE_DROP_TOLERANCE_MS;
}

function effectiveBannerVisible(): boolean {
  return bannerVisible && !qqForeground && !wechatForeground && !isSystemInactive();
}

function applyBannerVisibility(): void {
  if (bannerWindow) bannerWindow.setOpacity(effectiveBannerVisible() ? settings.opacity : 0);
}

function createBannerWindow(): void {
  const primary = screen.getPrimaryDisplay();
  const wa = primary.workArea;
  const width = Math.max(200, Math.round((wa.width * settings.widthPercent) / 100));
  const height = Math.max(80, Math.round((wa.height * settings.maxHeightPercent) / 100));
  const x = wa.x + Math.round((wa.width - width) / 2);
  const y = wa.y;

  bannerWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    focusable: false,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  bannerWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  bannerWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  bannerWindow.setIgnoreMouseEvents(true, { forward: false });
  applyBannerVisibility();
  bannerWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  bannerWindow.loadFile(rendererFile('banner.html'));
  hookRendererConsole(bannerWindow, 'banner');

  bannerWindow.webContents.on('did-finish-load', () => {
    bannerReady = true;
    sendBannerConfig();
  });

  bannerWindow.on('closed', () => {
    bannerWindow = null;
    bannerReady = false;
  });
}

function sendBannerConfig(): void {
  if (!bannerWindow || !bannerReady) return;
  bannerWindow.webContents.send('banner:config', {
    fontSize: settings.fontSize,
    opacity: settings.opacity,
    width: bannerWindow.getBounds().width,
    bgColor: settings.bannerBgColor,
    labelColor: settings.bannerLabelColor,
    nickColor: settings.bannerNickColor,
    textColor: settings.bannerTextColor
  });
}

function applyBannerBounds(): void {
  if (!bannerWindow) return;
  const primary = screen.getPrimaryDisplay();
  const wa = primary.workArea;
  const width = Math.max(200, Math.round((wa.width * settings.widthPercent) / 100));
  const height = Math.max(80, Math.round((wa.height * settings.maxHeightPercent) / 100));
  const x = wa.x + Math.round((wa.width - width) / 2);
  const y = wa.y;
  bannerWindow.setBounds({ x, y, width, height });
  applyBannerVisibility();
  sendBannerConfig();
}

function createScheduler(): void {
  scheduler = new BannerScheduler({
    getMaxHeight: () => (bannerWindow ? bannerWindow.getBounds().height : 0),
    getMaxCount: () => (settings.maxBannerCount || 0),
    measure: (item) => {
      let attempts = 0;
      const send = () => {
        if (bannerWindow && bannerReady) {
          bannerWindow.webContents.send('banner:measure', item);
        } else if (attempts < 100) {
          attempts += 1;
          setTimeout(send, 100);
        }
      };
      send();
    },
    show: (item) => {
      if (bannerWindow && bannerReady) bannerWindow.webContents.send('banner:show', item);
    },
    remove: (id) => {
      if (bannerWindow && bannerReady) bannerWindow.webContents.send('banner:remove', id);
    },
    durationFor
  });
}

function startOneBot(): void {
  if (onebot) onebot.stop();
  onebot = new OneBotClient();
  onebot.on('state', (state: ConnectionState) => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send('connection:state', state);
    }
  });
  onebot.on('account', (info: { userId: number | null; nickname: string }) => {
    if (consoleWindow && !consoleWindow.isDestroyed()) {
      consoleWindow.webContents.send('qq:account', info);
    }
  });
  onebot.on('message', (ev: OB11MessageEvent) => {
    void handleMessageEvent(ev);
  });
  onebot.on('notice', (ev: OB11NoticeEvent) => {
    void handleNoticeEvent(ev);
  });
  onebot.start(settings);
}

async function handleMessageEvent(ev: OB11MessageEvent): Promise<void> {
  if (isSystemInactive()) return;
  const msgTime = typeof ev.time === 'number' && ev.time > 0 ? ev.time * 1000 : 0;
  if (shouldDropStaleMessage(msgTime)) return;
  if (!onebot) return;
  if (ev.self_id) cachedSelfId = ev.self_id;
  const item = await normalizeMessageEvent(ev, settings, onebot);
  if (item && scheduler) scheduler.request(item);
}

async function handleNoticeEvent(ev: OB11NoticeEvent): Promise<void> {
  if (isSystemInactive()) return;
  const msgTime = typeof ev.time === 'number' && ev.time > 0 ? ev.time * 1000 : 0;
  if (shouldDropStaleMessage(msgTime)) return;
  if (!onebot) return;
  const item = await normalizeNoticeEvent(ev, settings, onebot);
  if (item && scheduler) scheduler.request(item);
}
function sendWechatState(info: WechatStateInfo): void {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.webContents.send('wechat:state', info);
  }
}

function startWechat(): void {
  if (!settings.enableWechat) return;
  if (wechat) wechat.stop();
  wechat = new WechatClient();
  wechat.setLanguage(settings.language);
  wechat.on('state', (info: WechatStateInfo) => {
    sendWechatState(info);
  });
  wechat.on('message', (payload: WechatMessagePayload) => {
    void handleWechatMessage(payload);
  });
  wechat.start();
}

function stopWechat(): void {
  if (wechat) {
    wechat.stop();
    wechat = null;
  }
}

function restartWechat(): void {
  stopWechat();
  startWechat();
}

async function handleWechatMessage(payload: WechatMessagePayload): Promise<void> {
  if (isSystemInactive()) return;
  const msgTime = typeof payload.ts === 'number' && payload.ts > 0 ? payload.ts * 1000 : 0;
  if (shouldDropStaleMessage(msgTime)) return;
  if (!scheduler) return;
  const item = normalizeWechatMessage(payload, settings);
  if (item && scheduler) scheduler.request(item);
}

function toggleBanner(): void {
  bannerVisible = !bannerVisible;
  applyBannerVisibility();
  updateTrayMenuVisibility();
}

function closeTrayMenu(): void {
  closeTraySubmenu();
  if (mouseClickWatcher) {
    mouseClickWatcher.stop();
    mouseClickWatcher = null;
  }
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.close();
  }
}

function closeTraySubmenu(): void {
  if (traySubmenuWindow && !traySubmenuWindow.isDestroyed()) {
    traySubmenuWindow.close();
  }
}

function sendTraySubmenuData(kind: 'qq' | 'wechat'): void {
  if (!traySubmenuWindow || traySubmenuWindow.isDestroyed()) return;
  traySubmenuWindow.webContents.send('tray:submenu-data', {
    kind,
    scope: {
      scopeSpecialPrivate: settings.scopeSpecialPrivate,
      scopeNormalPrivate: settings.scopeNormalPrivate,
      scopeNormalGroup: settings.scopeNormalGroup,
      wechatPrivate: settings.wechatPrivate,
      wechatGroup: settings.wechatGroup
    }
  });
}

function showTraySubmenu(kind: 'qq' | 'wechat', top: number): void {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
  const dims = kind === 'qq' ? { width: 136, height: 180 } : { width: 136, height: 104 };
  const positionSubmenu = () => {
    if (!traySubmenuWindow || traySubmenuWindow.isDestroyed() || !trayMenuWindow || trayMenuWindow.isDestroyed()) return;
    const b = trayMenuWindow.getBounds();
    traySubmenuWindow.setBounds({
      x: Math.round(b.x + b.width - 3),
      y: Math.round(b.y + top - 4),
      width: dims.width,
      height: dims.height
    }, false);
  };
  if (traySubmenuWindow && !traySubmenuWindow.isDestroyed()) {
    positionSubmenu();
    sendTraySubmenuData(kind);
    if (!traySubmenuWindow.isVisible()) traySubmenuWindow.showInactive();
    return;
  }
  traySubmenuWindow = new BrowserWindow({
    width: dims.width,
    height: dims.height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  traySubmenuWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  traySubmenuWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  traySubmenuWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  traySubmenuWindow.loadFile(rendererFile('tray-submenu.html'));
  traySubmenuWindow.webContents.once('did-finish-load', () => {
    if (!traySubmenuWindow || traySubmenuWindow.isDestroyed()) return;
    positionSubmenu();
    sendTraySubmenuData(kind);
    traySubmenuWindow.showInactive();
  });
  traySubmenuWindow.on('closed', () => {
    traySubmenuWindow = null;
  });
}

function startOutsideClickWatcher(): void {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
  if (!mouseClickWatcher) mouseClickWatcher = new MouseClickWatcher();
  mouseClickWatcher.start(180, () => {
    if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    if (tray) {
      const tb = tray.getBounds();
      if (tb.width > 0 && tb.height > 0 && cursor.x >= tb.x && cursor.x < tb.x + tb.width && cursor.y >= tb.y && cursor.y < tb.y + tb.height) {
        return;
      }
    }
    const b = trayMenuWindow.getBounds();
    const inside = cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
    if (traySubmenuWindow && !traySubmenuWindow.isDestroyed()) {
      const sb = traySubmenuWindow.getBounds();
      const insideSub = cursor.x >= sb.x && cursor.x < sb.x + sb.width && cursor.y >= sb.y && cursor.y < sb.y + sb.height;
      if (insideSub) return;
    }
    if (!inside) closeTrayMenu();
  });
}

function toggleTrayMenu(): void {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuWindow.isVisible()) {
    closeTrayMenu();
  } else {
    openTrayMenu();
  }
}

function removeShortcuts(): void {
  const desktopDir = path.join(os.homedir(), 'Desktop');
  const startMenuDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs'
  );
  for (const name of ['流萤QQ弹窗显示', 'Firefly QQ Danmaku']) {
    for (const file of [
      path.join(desktopDir, name + '.lnk'),
      path.join(startMenuDir, name + '.lnk')
    ]) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* ignore */ }
    }
  }
}

function removeAutostartEntry(): void {
  try {
    execFileSync('reg', ['delete', autostartRunKey(), '/v', autostartValueName(), '/f'], { windowsHide: true });
  } catch { /* ignore */ }
}

function removeUninstallRegistryEntry(): void {
  try {
    execFileSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\流萤QQ弹窗显示', '/f'], { windowsHide: true });
  } catch { /* ignore */ }
}

function scheduleInstallDirDeletion(): void {
  const dir = installDir();
  const pid = process.pid;
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `Wait-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'Start-Sleep -Milliseconds 800',
    `Remove-Item -LiteralPath '${dir}' -Recurse -Force`,
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'powershell.exe' -and ($_.CommandLine -like '*QQForeground*' -or $_.CommandLine -like '*DisplayPowerWatcherForm*' -or $_.CommandLine -like '*WechatForeground*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  ].join('\r\n');
  try {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
  } catch { /* ignore */ }
}

function closeUninstallDialog(): void {
  if (uninstallDialogWindow && !uninstallDialogWindow.isDestroyed()) {
    uninstallDialogWindow.close();
  }
}

function performUninstall(): void {
  if (quitting) return;
  quitting = true;
  closeUninstallDialog();
  removeShortcuts();
  removeAutostartEntry();
  removeUninstallRegistryEntry();
  scheduleInstallDirDeletion();
  app.quit();
}

function openUninstallDialog(): void {
  closeTrayMenu();
  if (uninstallDialogWindow && !uninstallDialogWindow.isDestroyed()) {
    uninstallDialogWindow.focus();
    return;
  }
  uninstallDialogWindow = new BrowserWindow({
    width: 360,
    height: 190,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  uninstallDialogWindow.setAlwaysOnTop(true, 'screen-saver', 1);
  uninstallDialogWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  uninstallDialogWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  uninstallDialogWindow.loadFile(rendererFile('uninstall.html'));
  uninstallDialogWindow.webContents.once('did-finish-load', () => {
    if (!uninstallDialogWindow || uninstallDialogWindow.isDestroyed()) return;
    const wa = screen.getPrimaryDisplay().workArea;
    const [w, h] = uninstallDialogWindow.getSize();
    uninstallDialogWindow.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + (wa.height - h) / 2), false);
    uninstallDialogWindow.show();
    uninstallDialogWindow.focus();
  });
  uninstallDialogWindow.on('closed', () => {
    uninstallDialogWindow = null;
  });
}

function createTray(): void {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  normalTrayImage = nativeImage.createFromPath(iconPath);
  tray = new Tray(normalTrayImage);
  tray.setToolTip(productName(settings.language));
  tray.on('click', () => {
    toggleTrayMenu();
  });
  tray.on('right-click', () => {
    toggleTrayMenu();
  });
}

function positionTrayMenuWindow(): void {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed()) return;
  let x = 0;
  let y = 0;
  const [w, h] = trayMenuWindow.getSize();
  try {
    const b = tray ? tray.getBounds() : null;
    const wa = screen.getPrimaryDisplay().workArea;
    if (b && b.width > 0 && b.height > 0) {
      x = Math.round(b.x + b.width / 2 - w / 2);
      y = Math.round(b.y - h - 8);
    } else {
      const cursor = screen.getCursorScreenPoint();
      x = cursor.x - w;
      y = cursor.y - h - 8;
    }
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - h));
  } catch {
    const cursor = screen.getCursorScreenPoint();
    x = cursor.x - w;
    y = cursor.y - h - 8;
  }
  trayMenuWindow.setPosition(x, y, false);
}

function updateTrayMenuVisibility(): void {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    trayMenuWindow.webContents.send('tray:visibility', bannerVisible);
  }
}

function broadcastI18nChanged(lang: Language): void {
  const wins = [installerWindow, consoleWindow, trayMenuWindow, traySubmenuWindow, uninstallDialogWindow];
  for (const w of wins) {
    if (w && !w.isDestroyed()) w.webContents.send('i18n:changed', lang);
  }
}

function applyLanguage(lang: Language): void {
  if (tray) tray.setToolTip(productName(lang));
  if (wechat) wechat.setLanguage(lang);
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.setTitle(productName(lang) + ' - ' + translate(lang, 'console.title'));
  }
  if (installerWindow && !installerWindow.isDestroyed()) {
    installerWindow.setTitle(translate(lang, 'installer.windowTitle'));
  }
  broadcastI18nChanged(lang);
}

function openTrayMenu(): void {
  if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
    positionTrayMenuWindow();
    updateTrayMenuVisibility();
    trayMenuWindow.show();
    trayMenuWindow.focus();
    startOutsideClickWatcher();
    return;
  }

  trayMenuWindow = new BrowserWindow({
    width: 204,
    height: 308,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  trayMenuWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  trayMenuWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  trayMenuWindow.loadFile(rendererFile('tray-menu.html'));
  trayMenuWindow.webContents.once('did-finish-load', () => {
    if (trayMenuWindow && !trayMenuWindow.isDestroyed()) {
      updateTrayMenuVisibility();
      positionTrayMenuWindow();
      trayMenuWindow.show();
      trayMenuWindow.focus();
      startOutsideClickWatcher();
    }
  });
  trayMenuWindow.on('closed', () => {
    closeTraySubmenu();
    trayMenuWindow = null;
  });
}

function openConsole(): void {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.focus();
    return;
  }
  consoleWindow = new BrowserWindow({
    width: 680,
    height: 820,
    title: productName(settings.language) + ' - ' + translate(settings.language, 'console.title'),
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  consoleWindow.loadFile(rendererFile('console.html'));
  consoleWindow.on('closed', () => {
    consoleWindow = null;
  });
}

function createInstallerWindow(): void {
  installerWindow = new BrowserWindow({
    width: 760,
    height: 720,
    title: translate(settings.language, 'installer.windowTitle'),
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  installerWindow.loadFile(rendererFile('installer.html'));
  installerWindow.on('closed', () => {
    installerWindow = null;
  });
}

function createShortcuts(target: string): void {
  const desktopDir = path.join(os.homedir(), 'Desktop');
  const startMenuDir = path.join(
    process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs'
  );
  const displayName = productName(settings.language);
  const options = {
    target,
    cwd: path.dirname(target),
    description: displayName,
    icon: target,
    iconIndex: 0
  };
  try {
    fs.mkdirSync(startMenuDir, { recursive: true });
    shell.writeShortcutLink(path.join(startMenuDir, displayName + '.lnk'), 'create', options);
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(desktopDir)) {
      shell.writeShortcutLink(path.join(desktopDir, displayName + '.lnk'), 'create', options);
    }
  } catch { /* ignore */ }
}

function writeUninstallEntry(target: string): void {
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\流萤QQ弹窗显示';
  const values: Array<[string, string]> = [
    ['DisplayName', productName(settings.language)],
    ['DisplayVersion', app.getVersion()],
    ['Publisher', 'Firefly'],
    ['InstallLocation', path.dirname(target)],
    ['DisplayIcon', target],
    ['UninstallString', '"' + target + '" --uninstall']
  ];
  for (const [name, value] of values) {
    execFile('reg', ['add', key, '/f', '/v', name, '/t', 'REG_SZ', '/d', value], { windowsHide: true }, () => { /* ignore */ });
  }
}
function autostartRunKey(): string {
  return 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
}

function autostartValueName(): string {
  return '流萤QQ弹窗显示';
}

function regQuery(key: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      resolve(err ? '' : stdout || '');
    });
  });
}

async function setAutostart(enabled: boolean): Promise<boolean> {
  const target = path.join(installDir(), '流萤QQ弹窗显示.exe');
  const cmd = '"' + target + '" --silent';
  return new Promise((resolve) => {
    const args = enabled
      ? ['add', autostartRunKey(), '/f', '/v', autostartValueName(), '/t', 'REG_SZ', '/d', cmd]
      : ['delete', autostartRunKey(), '/f', '/v', autostartValueName()];
    execFile('reg', args, { windowsHide: true }, (err) => {
      resolve(!err);
    });
  });
}

async function getAutostart(): Promise<boolean> {
  const out = await regQuery(autostartRunKey());
  const target = path.join(installDir(), '流萤QQ弹窗显示.exe');
  return out.includes(autostartValueName()) && out.includes(target);
}

function finishInstall(): void {
  const target = path.join(installDir(), '流萤QQ弹窗显示.exe');
  if (fs.existsSync(target)) {
    spawn(target, ['--installed'], { detached: true, stdio: 'ignore' }).unref();
  }
  quitting = true;
  app.quit();
}


function sendInstallProgress(percent: number, text: string): void {
  if (installerWindow && !installerWindow.isDestroyed()) {
    installerWindow.webContents.send('install:progress', { percent, text });
  }
}

async function performInstall(): Promise<{ ok: boolean; installDir?: string; error?: string }> {
  try {
    sendInstallProgress(5, translate(settings.language, 'installer.progress.prepare'));
    const dir = installDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, '流萤QQ弹窗显示.exe');
    sendInstallProgress(25, translate(settings.language, 'installer.progress.copy'));
    const source = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    if (source && fs.existsSync(source) && path.resolve(source).toLowerCase() !== path.resolve(target).toLowerCase()) {
      fs.copyFileSync(source, target);
    }
    sendInstallProgress(60, translate(settings.language, 'installer.progress.info'));
    fs.writeFileSync(
      installMarkerPath(),
      JSON.stringify({ version: app.getVersion(), installedAt: Date.now() }, null, 2),
      'utf8'
    );
    sendInstallProgress(80, translate(settings.language, 'installer.progress.shortcut'));
    createShortcuts(target);
    sendInstallProgress(92, translate(settings.language, 'installer.progress.uninstall'));
    writeUninstallEntry(target);
    sendInstallProgress(100, translate(settings.language, 'installer.progressDone'));
    return { ok: true, installDir: dir };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function hookRendererConsole(win: BrowserWindow | null, tag: string): void {
  if (!win) return;
  try {
    win.webContents.on('console-message', (...args: unknown[]) => {
      const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      try {
        fs.appendFileSync(path.join(app.getPath('userData'), 'renderer-debug.log'), '[' + tag + '] ' + line + '\n', 'utf8');
      } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

function registerIpc(): void {
  ipcMain.handle('env:check', async (): Promise<EnvCheckResult[]> => {
    return runEnvChecks(settings);
  });

  ipcMain.handle('app:install', async () => {
    return performInstall();
  });
  ipcMain.handle('installer:set-autostart', (_event, enabled: boolean) => setAutostart(!!enabled));
  ipcMain.handle('installer:get-autostart', () => getAutostart());
  ipcMain.handle('installer:finish', () => {
    finishInstall();
  });

  ipcMain.handle('settings:get', (): AppSettings => settings);

  ipcMain.handle('settings:reset', (): AppSettings => {
    const keep = {
      wsUrl: settings.wsUrl,
      token: settings.token,
      reconnectMs: settings.reconnectMs,
      language: settings.language,
      enableWechat: settings.enableWechat
    };
    const oldLanguage = settings.language;
    settings = saveSettings({ ...defaultSettings, ...keep });
    applyBannerBounds();
    if (scheduler) scheduler.recheck();
    if (oldLanguage !== settings.language) applyLanguage(settings.language);
    return settings;
  });

  ipcMain.handle('settings:set', (_event, next: AppSettings): AppSettings => {
    const oldWechat = settings.enableWechat;
    const oldLanguage = settings.language;
    const connChanged = settings.wsUrl !== next.wsUrl || settings.token !== next.token || settings.reconnectMs !== next.reconnectMs;
    settings = saveSettings(next);
    applyBannerBounds();
    if (scheduler) scheduler.recheck();
    if (oldLanguage !== settings.language) applyLanguage(settings.language);
    if (connChanged && onebot && !quitting) {
      onebot.stop();
      onebot.start(settings);
    }
    if (!quitting) {
      const wcChanged = oldWechat !== next.enableWechat;
      if (wcChanged) restartWechat();
    }
    return settings;
  });

  ipcMain.handle('shell:open', async (_event, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.on('banner:height', (_event, data: { id: string; height: number }) => {
    if (scheduler && data && typeof data.id === 'string' && typeof data.height === 'number') {
      scheduler.handleMeasured(data.id, Math.max(1, Math.round(data.height)));
    }
  });

  ipcMain.handle('tray:get-visibility', (): boolean => bannerVisible);
  ipcMain.handle('tray:toggle', (): boolean => {
    toggleBanner();
    return bannerVisible;
  });
  ipcMain.handle('tray:quit', (): void => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle('tray:uninstall-open', (): void => {
    openUninstallDialog();
  });
  ipcMain.handle('tray:uninstall-cancel', (): void => {
    closeUninstallDialog();
  });
  ipcMain.handle('tray:uninstall-confirm', (): void => {
    performUninstall();
  });
  ipcMain.handle('tray:get-scope', (): { scopeSpecialPrivate: boolean; scopeNormalPrivate: boolean; scopeNormalGroup: boolean; wechatPrivate: boolean; wechatGroup: boolean } => ({
    scopeSpecialPrivate: settings.scopeSpecialPrivate,
    scopeNormalPrivate: settings.scopeNormalPrivate,
    scopeNormalGroup: settings.scopeNormalGroup,
    wechatPrivate: settings.wechatPrivate,
    wechatGroup: settings.wechatGroup
  }));
  ipcMain.handle('tray:set-scope', (_event, patch: { scopeSpecialPrivate?: boolean; scopeNormalPrivate?: boolean; scopeNormalGroup?: boolean; wechatPrivate?: boolean; wechatGroup?: boolean }): { scopeSpecialPrivate: boolean; scopeNormalPrivate: boolean; scopeNormalGroup: boolean; wechatPrivate: boolean; wechatGroup: boolean } => {
    settings = saveSettings({ ...settings, ...patch });
    return {
      scopeSpecialPrivate: settings.scopeSpecialPrivate,
      scopeNormalPrivate: settings.scopeNormalPrivate,
      scopeNormalGroup: settings.scopeNormalGroup,
      wechatPrivate: settings.wechatPrivate,
      wechatGroup: settings.wechatGroup
    };
  });
  ipcMain.on('tray:submenu-show', (_event, data: { kind: 'qq' | 'wechat'; top: number }) => {
    if (!data || (data.kind !== 'qq' && data.kind !== 'wechat') || typeof data.top !== 'number') return;
    showTraySubmenu(data.kind, data.top);
  });
  ipcMain.handle('tray:refresh', async (): Promise<boolean> => {
    let ok = false;
    try {
      if (onebot) {
        await onebot.refresh();
        ok = true;
      }
    } catch { /* ignore */ }
    closeTrayMenu();
    return ok;
  });

  ipcMain.handle('tray:open-console', (): void => {
    openConsole();
  });

  ipcMain.handle('i18n:get-language', (): Language => settings.language);
  ipcMain.handle('i18n:set-language', (_event, lang: Language): Language => {
    const next: Language = lang === 'en' ? 'en' : 'zh';
    if (settings.language !== next) {
      settings = saveSettings({ ...settings, language: next });
      applyLanguage(next);
    }
    return settings.language;
  });
  ipcMain.handle('i18n:get-messages', (_event, lang: Language): Record<string, string> => {
    return messages[lang === 'en' ? 'en' : 'zh'] || messages.zh;
  });
}

function bindPowerMonitor(): void {
  if (powerMonitorBound) return;
  powerMonitorBound = true;
  powerMonitor.on('suspend', () => {
    suspended = true;
    applyBannerVisibility();
  });
  powerMonitor.on('resume', () => {
    suspended = false;
    lastResumeAt = Date.now();
    applyBannerVisibility();
  });
  powerMonitor.on('lock-screen', () => {
    sessionLocked = true;
    applyBannerVisibility();
  });
  powerMonitor.on('unlock-screen', () => {
    sessionLocked = false;
    applyBannerVisibility();
  });
}

function startInstalledApp(): void {
  settings = loadSettings();
  createScheduler();
  createBannerWindow();
  createTray();
  startOneBot();
  startWechat();
  // 路线B：LLOneBot 注入官方 QQ，禁止自动启动 NapCat，避免下线官方 QQ。
  napcatManager = new NapCatManager();
  // void napcatManager.start().catch(() => { /* NapCat 自动上线失败不阻塞程序 */ });
  bindPowerMonitor();
  displayPowerWatcher = new DisplayPowerWatcher();
  displayPowerWatcher.start((off: boolean) => {
    displayOff = off;
    applyBannerVisibility();
  });
  qqWindowWatcher = new QQWindowWatcher();
  qqWindowWatcher.start((foreground: boolean) => {
    qqForeground = foreground;
    applyBannerVisibility();
  });
  wechatWindowWatcher = new WechatWindowWatcher();
  wechatWindowWatcher.start((foreground: boolean) => {
    wechatForeground = foreground;
    applyBannerVisibility();
  });
}

function startInstallerApp(): void {
  settings = loadSettings();
  createInstallerWindow();
}

app.on('second-instance', () => {
  if (!isInstalledApp && installerWindow && !installerWindow.isDestroyed()) {
    installerWindow.focus();
  }
});

app.whenReady().then(() => {
  registerIpc();
  if (isInstalledApp) {
    startInstalledApp();
  } else {
    startInstallerApp();
  }
});

app.on('window-all-closed', () => {
  if (!isInstalledApp) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (uninstallDialogWindow && !uninstallDialogWindow.isDestroyed()) uninstallDialogWindow.destroy();
  if (consoleWindow && !consoleWindow.isDestroyed()) consoleWindow.destroy();
  if (mouseClickWatcher) {
    mouseClickWatcher.stop();
    mouseClickWatcher = null;
  }
  if (displayPowerWatcher) {
    displayPowerWatcher.stop();
    displayPowerWatcher = null;
  }
  if (qqWindowWatcher) qqWindowWatcher.stop();
  if (wechatWindowWatcher) wechatWindowWatcher.stop();
  if (scheduler) scheduler.clear();
  if (onebot) onebot.stop();
  stopWechat();
  if (napcatManager) { void napcatManager.stop(); }
});



