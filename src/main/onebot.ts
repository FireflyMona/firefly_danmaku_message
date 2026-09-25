import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { AppSettings, ChatPeer, ConnectionState, FavoriteEmoji, OB11Event, Segment, TargetContact } from '../shared/types';
import { translate } from '../shared/i18n';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface GroupInfo {
  group_id: number;
  group_name?: string;
  member_count?: number;
}

interface GroupMemberInfo {
  user_id?: number;
  nickname?: string;
  card?: string;
}

export class OneBotClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private echo = 0;
  private pending = new Map<number, PendingCall>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private settings: AppSettings | null = null;
  private groupNameCache = new Map<number, string>();
  private groupMemberCountCache = new Map<number, number>();
  private memberCache = new Map<string, string>();
  private dndGroups = new Set<number>();
  private specialCareFriends = new Set<number>();
  private friendNameCache = new Map<number, string>();
  private selfId: number | null = null;
  private loginNickname = '';

  start(settings: AppSettings): void {
    this.settings = settings;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('client stopped'));
    }
    this.pending.clear();
  }

  isConnected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private connect(): void {
    if (this.stopped || !this.settings) return;
    this.emit('state', { connected: false, message: translate(this.settings?.language || 'zh', 'conn.connecting', { url: this.settings.wsUrl }) } as ConnectionState);
    let url = this.settings.wsUrl || 'ws://127.0.0.1:3001';
    if (this.settings.token) {
      url += (url.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(this.settings.token);
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        handshakeTimeout: 5000,
        headers: this.settings.token ? { Authorization: 'Bearer ' + this.settings.token } : undefined
      });
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.emit('state', { connected: true, message: translate(this.settings?.language || 'zh', 'conn.connected', { url }) } as ConnectionState);
      this.refresh().catch(() => { /* non-fatal */ });
      this.getLoginInfo().then((info) => {
        if (info) {
          this.selfId = info.userId;
          this.loginNickname = info.nickname;
          this.emit('account', { userId: info.userId, nickname: info.nickname });
        }
      }).catch(() => { /* ignore */ });
    });

    ws.on('message', (data: Buffer) => {
      this.handleMessage(data.toString('utf8'));
    });

    ws.on('error', () => {
      this.emit('state', { connected: false, message: translate(this.settings?.language || 'zh', 'conn.error') } as ConnectionState);
    });

    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.emit('state', { connected: false, message: translate(this.settings?.language || 'zh', 'conn.closed') } as ConnectionState);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('connection closed'));
      }
      this.pending.clear();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.settings || this.reconnectTimer) return;
    const delay = Math.max(1000, this.settings.reconnectMs || 3000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handleMessage(text: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    if (parsed && typeof parsed.echo === 'number' && this.pending.has(parsed.echo)) {
      const p = this.pending.get(parsed.echo)!;
      this.pending.delete(parsed.echo);
      clearTimeout(p.timer);
      if (parsed.status === 'failed' || parsed.retcode !== undefined && parsed.retcode !== 0) {
        p.reject(new Error(parsed.message || parsed.msg || 'API call failed'));
      } else {
        p.resolve(parsed.data !== undefined ? parsed.data : parsed);
      }
      return;
    }

    if (!parsed || !parsed.post_type) return;
    if (parsed.post_type === 'message') {
      this.emit('message', parsed as OB11Event);
    } else if (parsed.post_type === 'notice') {
      this.emit('notice', parsed as OB11Event);
    }
  }

  call(action: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<any> {
    if (!this.isConnected()) {
      return Promise.reject(new Error(translate(this.settings?.language || 'zh', 'conn.onebotNotConnected')));
    }
    const echo = ++this.echo;
    const payload = { action, params, echo };
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(translate(this.settings?.language || 'zh', 'conn.onebotTimeout', { action })));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(err as Error);
      }
    });
  }

  public async refresh(): Promise<void> {
    await Promise.all([
      this.preloadGroups(),
      this.preloadSpecialCare(),
      this.preloadFriendNames()
    ]);
  }

  private async preloadGroups(): Promise<void> {
    const nextDnd = new Set<number>();
    try {
      const data = await this.call('get_group_list', {});
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
      const ids: number[] = [];
      for (const g of list) {
        if (g && typeof g.group_id === 'number') {
          ids.push(g.group_id);
          if (g.group_name) this.groupNameCache.set(g.group_id, g.group_name);
          if (typeof g.member_count === 'number') this.groupMemberCountCache.set(g.group_id, g.member_count);
          if (typeof g.msg_mask === 'number' && g.msg_mask !== 1) {
            nextDnd.add(g.group_id);
          }
        }
      }
      await this.collectGroupDnd(ids, nextDnd);
    } catch {
      // ignore; lazy fallback still works
    }
    this.dndGroups = nextDnd;
  }

  private async collectGroupDnd(ids: number[], out: Set<number>, concurrency = 8): Promise<void> {
    let cursor = 0;
    const workers: Promise<void>[] = [];
    const workerCount = Math.max(1, Math.min(concurrency, ids.length));
    for (let w = 0; w < workerCount; w += 1) {
      workers.push((async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= ids.length) break;
          const groupId = ids[index];
          try {
            const data = await this.call('get_group_info', { group_id: groupId, no_cache: false }, 8000);
            const info = (data && data.data ? data.data : data) as any;
            const groupAll = info && info.groupAll ? info.groupAll : null;
            // LLOneBot 将原生群资料放在 groupAll 中；cmdUinMsgMask 为 QQ 群消息提醒位掩码。
            const mask = Number(groupAll && groupAll.cmdUinMsgMask);
            if (groupAll && Number.isFinite(mask) && (mask & 6) !== 0) {
              out.add(groupId);
            } else if (info && typeof info.msg_mask === 'number' && info.msg_mask !== 1) {
              out.add(groupId);
            }
          } catch {
            // LLOneBot/NapCat 个别群查询失败时忽略，避免阻塞其它群
          }
        }
      })());
    }
    await Promise.all(workers);
  }

  private async preloadSpecialCare(): Promise<void> {
    this.specialCareFriends.clear();
    try {
      const data = await this.call('get_friends_with_category', {});
      const categories = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
      for (const category of categories) {
        if (!category) continue;
        const name = String(category.categoryName || category.categroyName || '');
        const id = Number(category.categoryId);
        if (name === '特别关心' || id === 9999) {
          const buddies = Array.isArray(category.buddyList) ? category.buddyList : [];
          for (const buddy of buddies) {
            const userId = Number(buddy && buddy.user_id);
            if (Number.isFinite(userId) && userId > 0) this.specialCareFriends.add(userId);
          }
        }
      }
    } catch {
      // ignore; special-care highlight is best-effort
    }
  }

  private async preloadFriendNames(): Promise<void> {
    try {
      const data = await this.call('get_friend_list', {}, 20000);
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
      for (const f of list) {
        const id = Number(f && f.user_id);
        if (Number.isFinite(id) && id > 0) {
          this.friendNameCache.set(id, String(f.remark || f.nickname || id));
        }
      }
    } catch { /* ignore */ }
  }

  async resolveFriendName(userId: number): Promise<string | null> {
    const cached = this.friendNameCache.get(userId);
    if (cached) return cached;
    return null;
  }

  isSpecialCare(userId: number): boolean {

    return this.specialCareFriends.has(userId);
  }

  getSelfId(): number | null {
    return this.selfId;
  }

  async getLoginInfo(): Promise<{ userId: number; nickname: string } | null> {
    try {
      const data = await this.call('get_login_info', {}, 5000);
      const info = (data && data.data ? data.data : data) as any;
      const id = Number(info && info.user_id);
      if (!(Number.isFinite(id) && id > 0)) return null;
      return { userId: id, nickname: String(info && info.nickname ? info.nickname : '') };
    } catch {
      return null;
    }
  }

  async resolveGroupName(groupId: number): Promise<string> {
    const cached = this.groupNameCache.get(groupId);
    if (cached) return cached;
    try {
      const data = await this.call('get_group_info', { group_id: groupId, no_cache: false });
      const info = (data && data.data ? data.data : data) as GroupInfo;
      const name = info && info.group_name ? info.group_name : String(groupId);
      this.groupNameCache.set(groupId, name);
      if (info && typeof info.member_count === 'number') this.groupMemberCountCache.set(groupId, info.member_count);
      return name;
    } catch {
      return String(groupId);
    }
  }

  async resolveGroupMemberCount(groupId: number): Promise<number | null> {
    const cached = this.groupMemberCountCache.get(groupId);
    if (typeof cached === 'number') return cached;
    try {
      const data = await this.call('get_group_info', { group_id: groupId, no_cache: false });
      const info = (data && data.data ? data.data : data) as GroupInfo;
      if (info && typeof info.member_count === 'number') {
        this.groupMemberCountCache.set(groupId, info.member_count);
        return info.member_count;
      }
      return null;
    } catch {
      return null;
    }
  }

  async resolveMemberName(groupId: number, userId: number): Promise<string> {
    const key = groupId + ':' + userId;
    const cached = this.memberCache.get(key);
    if (cached) return cached;
    try {
      const data = await this.call('get_group_member_info', { group_id: groupId, user_id: userId, no_cache: false });
      const info = (data && data.data ? data.data : data) as GroupMemberInfo;
      const name = info.card || info.nickname || String(userId);
      this.memberCache.set(key, name);
      return name;
    } catch {
      return String(userId);
    }
  }

  isGroupDnd(groupId: number): boolean {
    return this.dndGroups.has(groupId);
  }

  async sendMessage(peer: ChatPeer, segments: Segment[]): Promise<number> {
    const action = peer.kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const key = peer.kind === 'private' ? 'user_id' : 'group_id';
    const data = await this.call(action, { [key]: peer.id, message: segments }, 15000);
    const mid = (data && data.message_id) !== undefined ? Number(data.message_id) : 0;
    return mid;
  }

  async recallMessage(messageId: number): Promise<void> {
    await this.call('delete_msg', { message_id: messageId }, 10000);
  }

  async forwardSingle(target: ChatPeer, messageId: number): Promise<void> {
    const action = target.kind === 'private' ? 'forward_friend_single_msg' : 'forward_group_single_msg';
    const key = target.kind === 'private' ? 'user_id' : 'group_id';
    await this.call(action, { [key]: target.id, message_id: messageId }, 15000);
  }

  async forwardMerge(target: ChatPeer, nodes: Segment[]): Promise<void> {
    const action = target.kind === 'private' ? 'send_private_forward_msg' : 'send_group_forward_msg';
    const key = target.kind === 'private' ? 'user_id' : 'group_id';
    await this.call(action, { [key]: target.id, messages: nodes }, 20000);
  }

  async voiceToText(messageId: number): Promise<string> {
    const data = await this.call('fetch_ptt_text', { message_id: messageId }, 20000);
    const obj = (data && data.data ? data.data : data) as any;
    return String(obj && obj.text ? obj.text : '');
  }

  async fetchFavoriteEmoji(): Promise<FavoriteEmoji[]> {
    try {
      const data = await this.call('fetch_custom_face_detail', { count: 200 }, 15000);
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
      const out: FavoriteEmoji[] = [];
      for (const item of list) {
        if (!item) continue;
        const id = String(item.emojiId ?? item.id ?? '');
        const url = String(item.url ?? item.path ?? item.emojiPath ?? '');
        if (!url) continue;
        out.push({ id, url, desc: String(item.desc ?? item.name ?? item.description ?? '') });
      }
      if (out.length) return out;
      // 回退到纯 URL 列表
      const simple = await this.call('fetch_custom_face', { count: 200 }, 15000);
      const urls = Array.isArray(simple) ? simple : (simple && Array.isArray(simple.data) ? simple.data : []);
      return (urls as unknown[]).filter((u) => typeof u === 'string' && u).map((u) => ({ id: u as string, url: u as string }));
    } catch {
      return [];
    }
  }

  async getTargetContacts(): Promise<TargetContact[]> {
    const out: TargetContact[] = [];
    const seenPrivate = new Set<number>();
    const seenGroup = new Set<number>();

    // 好友列表优先；失败时用“带分组好友列表”兜底
    try {
      const friends = await this.call('get_friend_list', {}, 20000);
      const fl = Array.isArray(friends) ? friends : (friends && Array.isArray(friends.data) ? friends.data : []);
      for (const f of fl) {
        const id = Number(f && f.user_id);
        if (Number.isFinite(id) && id > 0 && !seenPrivate.has(id)) {
          seenPrivate.add(id);
          out.push({ kind: 'private', id, name: String(f.nickname || f.remark || id) });
        }
      }
    } catch { /* ignore */ }

    if (seenPrivate.size === 0) {
      try {
        const data = await this.call('get_friends_with_category', {}, 20000);
        const categories = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
        for (const category of categories) {
          const buddies = Array.isArray(category && category.buddyList) ? category.buddyList : [];
          for (const buddy of buddies) {
            const id = Number(buddy && buddy.user_id);
            if (Number.isFinite(id) && id > 0 && !seenPrivate.has(id)) {
              seenPrivate.add(id);
              out.push({ kind: 'private', id, name: String(buddy.nickname || buddy.remark || id) });
            }
          }
        }
      } catch { /* ignore */ }
    }

    try {
      const groups = await this.call('get_group_list', {}, 20000);
      const gl = Array.isArray(groups) ? groups : (groups && Array.isArray(groups.data) ? groups.data : []);
      for (const g of gl) {
        const id = Number(g && g.group_id);
        if (Number.isFinite(id) && id > 0 && !seenGroup.has(id)) {
          seenGroup.add(id);
          out.push({ kind: 'group', id, name: String(g.group_name || id) });
        }
      }
    } catch { /* ignore */ }
    return out;
  }

  async markRead(peer: ChatPeer): Promise<void> {
    try {
      if (peer.kind === 'private') {
        await this.call('mark_private_msg_as_read', { user_id: peer.id }, 5000);
      } else {
        await this.call('mark_group_msg_as_read', { group_id: peer.id }, 5000);
      }
    } catch { /* ignore */ }
  }
}
