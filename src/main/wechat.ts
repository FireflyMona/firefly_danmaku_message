import { EventEmitter } from 'events';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WechatMessagePayload } from '../shared/types';
import { translate, Language } from '../shared/i18n';

export type WechatState = 'idle' | 'starting' | 'ready' | 'error';

export interface WechatStateInfo {
  state: WechatState;
  message: string;
  loggedIn: boolean;
  selfWxid?: string;
  nickname?: string;
}

function resolvePython(): string | null {
  const candidates = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { windowsHide: true, stdio: 'ignore', timeout: 3000 });
      return c;
    } catch {
      // 尝试下一个
    }
  }
  return null;
}

function resolveListenerScript(): string {
  const candidates = [
    path.join(process.resourcesPath, 'python', 'wechat_listener.py'),
    path.join(process.cwd(), 'python', 'wechat_listener.py'),
    path.join(__dirname, '..', '..', 'python', 'wechat_listener.py')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

// 微信消息客户端：通过 wechatauto-replica（Python）监听微信 4.x 本地数据库，
// 由 Python 监听器把新消息以 JSON 行写到 stdout，本客户端逐行解析后上报。
export class WechatClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private stopped = true;
  private state: WechatState = 'idle';
  private loggedIn = false;
  private selfWxid = '';
  private nickname = '';
  private buffer = '';
  private language: Language = 'zh';

  constructor() {
    super();
  }

  setLanguage(lang: Language): void {
    this.language = lang === 'en' ? 'en' : 'zh';
  }

  start(): void {
    this.stop();
    this.stopped = false;
    this.setState('starting', translate(this.language, 'wechat.state.starting'), false);

    const script = resolveListenerScript();
    if (!fs.existsSync(script)) {
      this.setState('error', translate(this.language, 'wechat.state.scriptMissing', { script }), false);
      this.stopped = true;
      return;
    }
    const python = resolvePython();
    if (!python) {
      this.setState('error', translate(this.language, 'wechat.state.pythonMissing'), false);
      this.stopped = true;
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(python, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      this.setState('error', translate(this.language, 'wechat.state.startFailed', { err: String((err && err.message) || err) }), false);
      this.stopped = true;
      return;
    }
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on('data', () => { /* 忽略 stderr，避免子进程因管道阻塞 */ });
    child.on('error', (err) => {
      if (this.stopped) return;
      this.setState('error', translate(this.language, 'wechat.state.processError', { err: String((err && err.message) || err) }), false);
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (!this.stopped) {
        this.setState('error', translate(this.language, 'wechat.state.exited', { code: code ? translate(this.language, 'wechat.state.exitCode', { code }) : '' }), false);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
    }
    this.loggedIn = false;
    this.selfWxid = '';
    this.nickname = '';
    this.buffer = '';
    this.setState('idle', translate(this.language, 'wechat.state.idle'), false);
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  getState(): WechatState {
    return this.state;
  }

  private setState(state: WechatState, message: string, loggedIn: boolean): void {
    this.state = state;
    this.loggedIn = loggedIn;
    this.emit('state', { state, message, loggedIn, selfWxid: this.selfWxid, nickname: this.nickname } as WechatStateInfo);
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.event) {
      case 'ready':
        this.selfWxid = String(msg.selfWxid || '');
        this.nickname = String(msg.nickname || '');
        this.setState('ready', translate(this.language, 'wechat.state.ready', { nick: msg.nickname || translate(this.language, 'wechat.state.signedIn') }), true);
        break;
      case 'error':
        this.setState('error', translate(this.language, 'wechat.state.listenerError', { err: String(msg.error || translate(this.language, 'common.unknown')) }), false);
        break;
      case 'message': {
        const payload = msg as WechatMessagePayload;
        if (payload && typeof payload === 'object') {
          if (!payload.selfWxid) payload.selfWxid = this.selfWxid;
          this.emit('message', payload);
        }
        break;
      }
      default:
        break;
    }
  }
}
