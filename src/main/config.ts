import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { AppSettings } from '../shared/types';

export const defaultSettings: AppSettings = {
  wsUrl: 'ws://127.0.0.1:3001',
  token: '',
  reconnectMs: 3000,
  scopeSpecialPrivate: true,
  scopeNormalPrivate: true,
  scopeNormalGroup: true,
  wechatPrivate: true,
  wechatGroup: true,
  maxBannerCount: 0,
  bannerBgColor: '#ffffff',
  bannerLabelColor: '#0a7cff',
  bannerNickColor: '#ff6b00',
  bannerTextColor: '#000000',
  maxHeightPercent: 25,
  fontSize: 16,
  opacity: 0.92,
  widthPercent: 33,
  secondsPerLine: 5,
  enableWechat: false,
  language: 'zh'
};

let settings: AppSettings | null = null;

export function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): AppSettings {
  if (settings) return settings;
  const file = settingsPath();
  migrateLegacySettings(file);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    settings = { ...defaultSettings, ...parsed };
  } catch {
    settings = { ...defaultSettings };
  }
  return settings as AppSettings;
}

function migrateLegacySettings(targetFile: string): void {
  try {
    if (fs.existsSync(targetFile)) return;
    const legacyFile = path.join(app.getPath('appData'), 'firefly-qq-danmaku', 'settings.json');
    if (fs.existsSync(legacyFile)) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      fs.copyFileSync(legacyFile, targetFile);
    }
  } catch { /* ignore */ }
}

export function saveSettings(next: AppSettings): AppSettings {
  settings = { ...defaultSettings, ...next };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  return settings as AppSettings;
}
