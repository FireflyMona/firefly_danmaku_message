export type SegmentType = 'text' | 'face' | 'image' | 'record' | 'video' | 'file' | 'at' | 'reply' | 'forward' | 'node' | string;

export interface Segment {
  type: SegmentType;
  data: Record<string, string>;
}

export interface OB11Sender {
  user_id: number;
  nickname?: string;
  card?: string;
}

export interface OB11MessageEvent {
  post_type: 'message';
  message_type: 'private' | 'group';
  sub_type: string;
  self_id: number;
  user_id: number;
  group_id?: number;
  message_id?: number;
  time?: number;
  sender: OB11Sender;
  raw_message?: string;
  message: Segment[];
}

export interface OB11NoticeEvent {
  post_type: 'notice';
  notice_type: string;
  sub_type?: string;
  self_id?: number;
  group_id?: number;
  user_id?: number;
  operator_id?: number;
  time?: number;
}

export interface OB11MetaEvent {
  post_type: 'meta_event';
  [key: string]: unknown;
}

export type OB11Event = OB11MessageEvent | OB11NoticeEvent | OB11MetaEvent;

export type BannerKind = 'private' | 'group' | 'notice';

export interface BannerItem {
  id: string;
  kind: BannerKind;
  label: string;
  avatar: string;
  nickname: string;
  text: string;
  createdAt: number;
  expiresAt: number;
  height?: number;
  special?: boolean;
  dnd?: boolean;
  source?: 'qq' | 'wechat';
}

export interface AppSettings {
  wsUrl: string;
  token: string;
  reconnectMs: number;
  scopeSpecialPrivate: boolean;
  scopeNormalPrivate: boolean;
  scopeNormalGroup: boolean;
  wechatPrivate: boolean;
  wechatGroup: boolean;
  maxBannerCount: number;
  bannerBgColor: string;
  bannerLabelColor: string;
  bannerNickColor: string;
  bannerTextColor: string;
  maxHeightPercent: number;
  fontSize: number;
  opacity: number;
  widthPercent: number;
  secondsPerLine: number;
  enableWechat: boolean;
  language: 'zh' | 'en';
}

export interface EnvCheckResult {
  id: string;
  ok: boolean;
  level: 'ok' | 'warn' | 'error';
  title: string;
  detail: string;
  guidance: string;
  link?: string;
  required?: boolean;
}

export interface ConnectionState {
  connected: boolean;
  message: string;
}

export type ChatKind = 'private' | 'group';

export interface ChatPeer {
  kind: ChatKind;
  id: number;
}

export interface ChatMessage {
  id: string;
  messageId?: number;
  peer: ChatPeer;
  direction: 'in' | 'out';
  senderUserId: number;
  senderName: string;
  avatar: string;
  segments: Segment[];
  plainText: string;
  ts: number;
  localFilePath?: string;
  voiceText?: string;
  recalled?: boolean;
}

export interface Conversation {
  key: string;
  peer: ChatPeer;
  title: string;
  avatar: string;
  lastText: string;
  lastTs: number;
  unread: number;
  pinned: boolean;
  memberCount?: number;
  special?: boolean;
  dnd?: boolean;
}

export interface FavoriteEmoji {
  id: string;
  url: string;
  desc?: string;
}

export interface TargetContact {
  kind: ChatKind;
  id: number;
  name: string;
}

// 微信消息负载：由 wechatauto 监听器解析后传给主进程
export interface WechatMessagePayload {
  id: string;
  isSelf: boolean;
  isGroup: boolean;
  roomid: string;
  sender: string;
  content: string;
  type: string;
  ts: number;
  nickname: string;
  roomName: string;
  avatar: string;
  selfWxid: string;
}

