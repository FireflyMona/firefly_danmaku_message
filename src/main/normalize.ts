import { randomUUID } from 'crypto';
import { AppSettings, BannerItem, OB11MessageEvent, OB11NoticeEvent, Segment, WechatMessagePayload } from '../shared/types';
import { translate } from '../shared/i18n';
import { OneBotClient } from './onebot';

function qqAvatar(qq: number): string {
  return 'https://q.qlogo.cn/headimg_dl?dst_uin=' + qq + '&spec=100';
}

function segmentText(seg: Segment, lang: 'zh' | 'en'): string {
  const data = seg.data || {};
  switch (seg.type) {
    case 'text':
      return data.text || '';
    case 'face':
      return translate(lang, 'banner.face');
    case 'image':
      return translate(lang, 'banner.image');
    case 'record':
      return translate(lang, 'banner.voice');
    case 'video':
      return translate(lang, 'banner.video');
    case 'file':
      return translate(lang, 'banner.file');
    case 'at':
      return '@' + (data.qq || translate(lang, 'common.unknown'));
    case 'reply':
      return '';
    default:
      return '';
  }
}

function buildContent(segments: Segment[] | undefined, raw: string | undefined, lang: 'zh' | 'en'): string {
  if (Array.isArray(segments) && segments.length > 0) {
    const parts: string[] = [];
    for (const seg of segments) {
      const text = segmentText(seg, lang);
      if (text) parts.push(text);
    }
    return parts.join(' ').trim() || (raw || '').trim();
  }
  return (raw || '').trim();
}

export async function normalizeMessageEvent(
  ev: OB11MessageEvent,
  settings: AppSettings,
  client: OneBotClient
): Promise<BannerItem | null> {
  if (!ev || ev.sender.user_id === ev.self_id) return null;

  const isGroup = ev.message_type === 'group';
  const groupId = ev.group_id;
  const special = !isGroup && client.isSpecialCare(ev.sender.user_id);

  if (!isGroup) {
    if (special && !settings.scopeSpecialPrivate) return null;
    if (!special && !settings.scopeNormalPrivate) return null;
  } else {
    if (!settings.scopeNormalGroup) return null;
    if (groupId && client.isGroupDnd(groupId)) return null;
  }
  const label = isGroup ? await client.resolveGroupName(groupId!) : translate(settings.language, 'common.private');
  const avatar = qqAvatar(ev.sender.user_id);
  const nickname = ev.sender.nickname || String(ev.sender.user_id);
  const text = buildContent(ev.message, ev.raw_message, settings.language);

  return {
    id: randomUUID(),
    kind: isGroup ? 'group' : 'private',
    label,
    avatar,
    nickname,
    text,
    createdAt: Date.now(),
    expiresAt: 0,
    special
  };
}

export async function normalizeNoticeEvent(
  ev: OB11NoticeEvent,
  settings: AppSettings,
  client: OneBotClient
): Promise<BannerItem | null> {
  const noticeType = ev.notice_type;
  const groupId = ev.group_id;
  if (!groupId) return null;
  if (client.isGroupDnd(groupId)) return null;

  const label = await client.resolveGroupName(groupId);
  const userId = ev.user_id || ev.operator_id || 0;
  const avatar = qqAvatar(userId || 10000);

  let text = translate(settings.language, 'banner.notice');
  const subType = ev.sub_type || '';
  const lang = settings.language;

  try {
    if (noticeType === 'group_increase') {
      const name = await client.resolveMemberName(groupId, ev.user_id || 0);
      if (ev.operator_id && ev.operator_id !== ev.user_id) {
        const op = await client.resolveMemberName(groupId, ev.operator_id);
        text = translate(lang, 'banner.notice.invite', { op, name });
      } else {
        text = translate(lang, 'banner.notice.join', { name });
      }
    } else if (noticeType === 'group_decrease') {
      const name = await client.resolveMemberName(groupId, ev.user_id || 0);
      if (subType === 'leave') {
        text = translate(lang, 'banner.notice.leave', { name });
      } else if (subType === 'kick') {
        const op = await client.resolveMemberName(groupId, ev.operator_id || 0);
        text = translate(lang, 'banner.notice.kick', { op, name });
      } else if (subType === 'kick_me') {
        const op = await client.resolveMemberName(groupId, ev.operator_id || 0);
        text = translate(lang, 'banner.notice.kickMe', { op });
      } else {
        text = translate(lang, 'banner.notice.leave', { name });
      }
    } else if (noticeType === 'group_admin') {
      const name = await client.resolveMemberName(groupId, ev.user_id || 0);
      text = subType === 'set' ? translate(lang, 'banner.notice.adminSet', { name }) : translate(lang, 'banner.notice.adminUnset', { name });
    } else if (noticeType === 'group_ban') {
      const name = await client.resolveMemberName(groupId, ev.user_id || 0);
      text = subType === 'ban' ? translate(lang, 'banner.notice.ban', { name }) : translate(lang, 'banner.notice.unban', { name });
    } else if (noticeType === 'group_recall') {
      const name = await client.resolveMemberName(groupId, ev.user_id || 0);
      text = translate(lang, 'banner.notice.recall', { name });
    }
  } catch {
    text = translate(lang, 'banner.notice.fallback');
  }

  return {
    id: randomUUID(),
    kind: 'notice',
    label,
    avatar,
    nickname: translate(lang, 'banner.notice'),
    text,
    createdAt: Date.now(),
    expiresAt: 0
  };
}

export function normalizeWechatMessage(payload: WechatMessagePayload, settings: AppSettings): BannerItem | null {
  if (!payload) return null;
  if (payload.isSelf) return null;
  if (payload.type === 'system') return null;
  const isGroup = !!payload.isGroup;
  if (isGroup) {
    if (!settings.wechatGroup) return null;
  } else {
    if (!settings.wechatPrivate) return null;
  }
  const lang = settings.language;
  const roomName = payload.roomName || payload.roomid || translate(lang, 'common.group');
  const label = isGroup ? translate(lang, 'banner.wechat.group', { room: roomName }) : translate(lang, 'banner.wechat.private');
  const nickname = payload.nickname || payload.sender || translate(lang, 'banner.wechat.user');
  const text = wechatContentText(payload, lang);
  if (!text) return null;

  return {
    id: randomUUID(),
    kind: isGroup ? 'group' : 'private',
    label,
    avatar: payload.avatar || '',
    nickname,
    text,
    createdAt: Date.now(),
    expiresAt: 0,
    source: 'wechat'
  };
}

function wechatContentText(payload: WechatMessagePayload, lang: 'zh' | 'en'): string {
  const content = (payload.content || '').trim();
  switch (payload.type) {
    case 'text':
      return content || translate(lang, 'banner.wechat.message');
    case 'image':
      return translate(lang, 'banner.image');
    case 'voice':
      return translate(lang, 'banner.voice');
    case 'video':
      return translate(lang, 'banner.video');
    case 'emoji':
      return translate(lang, 'banner.face');
    case 'location':
      return translate(lang, 'banner.location');
    case 'file':
      return translate(lang, 'banner.file');
    case 'link':
      return content || translate(lang, 'banner.link');
    case 'card':
      return content || translate(lang, 'banner.card');
    case 'system':
      return '';
    case 'recall':
      return translate(lang, 'banner.wechat.recall');
    default:
      return content || translate(lang, 'banner.wechat.message');
  }
}
