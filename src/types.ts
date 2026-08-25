import type { TelegramClient } from 'telegram';

// ─────────────────────────────────────────────────────────────────────────────
// Ranh giới dữ liệu Telegram
//
// Mọi thứ đi ra từ GramJS được khai `TgRaw` TƯỜNG MINH. Không phải vì lười: các
// đối tượng MTProto là union rất rộng, phân biệt lúc chạy bằng `className`
// ('MessageMediaPhoto', 'DocumentAttributeAudio', 'Channel'…). Ép kiểu cứng ở
// ranh giới sẽ compile xanh trong khi runtime nhận nhánh khác hẳn.
//
// Ranh giới đúng là: lỏng khi NHẬN từ Telegram, chặt khi GỬI đi upstream.
// Vì vậy các *Payload bên dưới (thứ ta tự dựng) đều khai đầy đủ.
// ─────────────────────────────────────────────────────────────────────────────

/** Đối tượng thô từ GramJS — không tin được shape, luôn đọc phòng thủ. */
export type TgRaw = any;

export type TgClient = TelegramClient;

// ── Cấu hình ────────────────────────────────────────────────────────────────

export interface Config {
  apiId: number;
  apiHash: string;
  port: number;
  /** Base URL của hệ thống nhận inbound và cấp phiên để khôi phục. */
  upstreamBaseUrl: string;
  /** Đường webhook phía upstream — đổi được bằng env để cắm vào hệ khác. */
  upstreamWebhookPath: string;
  /** Endpoint upstream trả danh sách phiên cần khôi phục. */
  upstreamSessionsPath: string;
  systemKey: string;
  /** Địa chỉ upstream gọi NGƯỢC lại service để lấy ảnh/tệp. */
  publicBaseUrl: string;
  qrSessionTimeoutMs: number;
  passwordTimeoutMs: number;
  syncDialogLimit: number;
  syncMessageLimit: number;
  connectionRetries: number;
}

// ── Phiên ───────────────────────────────────────────────────────────────────

export type SessionStatus =
  | 'waiting'
  | 'password_required'
  | 'password_invalid'
  | 'confirmed'
  | 'expired'
  | 'error';

export interface SessionRecord {
  client: TgClient | null;
  tempAccountId: string | null;
  status: SessionStatus;
  accountId: string | null;
  displayName: string | null;
  username: string | null;
  phone: string | null;
  avatarUrl: string | null;
  /** Chuỗi phiên GramJS — đủ để đăng nhập lại mà không quét QR. Upstream nên mã hoá khi lưu. */
  sessionString: string | null;
  /** Ảnh QR mới nhất dạng data URL. Telegram làm mới token ~30s nên trường này ĐỔI. */
  qrImageUrl: string | null;
  qrUpdatedAt: number | null;
  passwordHint: string | null;
  /** Hàm giải phóng lời gọi đăng nhập đang chờ mật khẩu. Xem qrLogin.ts. */
  submitPassword: ((password: string) => void) | null;
  errorReason: string | null;
  createdAt: number;
  connected: boolean;
  lastEventAt: number | null;
}

export interface SessionSummary {
  accountId: string | null;
  status: SessionStatus;
  displayName: string | null;
  connected: boolean;
}

export interface ConnState {
  connected?: boolean;
  lastEventAt?: number;
}

/** Một phiên do upstream trả về để khôi phục. */
export interface UpstreamSession {
  externalId: string;
  displayName: string;
  sessionString: string | null;
}

// ── Đối tác hội thoại ───────────────────────────────────────────────────────

export type PeerKind = 'user' | 'bot' | 'group' | 'channel' | 'unknown';

export interface PeerDescriptor {
  peerId: string | null;
  kind: PeerKind;
  displayName: string | null;
  username: string | null;
  phone: string | null;
  avatarUrl: string | null;
}

export interface SelfDescriptor {
  accountId: string | null;
  displayName: string;
  username: string | null;
  phone: string | null;
  avatarUrl: string | null;
}

// ── Nội dung tin ────────────────────────────────────────────────────────────

export type AttachmentType =
  | 'image' | 'video' | 'audio' | 'file' | 'sticker'
  | 'location' | 'contact' | 'unknown';

export interface Attachment {
  type: AttachmentType;
  url?: string;
  name?: string | null;
  mimeType?: string;
  size?: number | null;
  /** Chỉ với type 'location'. */
  latitude?: number;
  longitude?: number;
  /** Chỉ với type 'contact'. */
  phone?: string | null;
  /** Chỉ với type 'unknown' — className thật của Telegram, để đọc ra shape sau. */
  className?: string;
}

export type Direction = 'In' | 'Out';

/** Phần thân đẩy về upstream cho một tin. */
export interface InboundPayload {
  accountId: string;
  /** Hội thoại. Chat riêng: id đối tác. Nhóm: id NHÓM (không phải người gửi). */
  threadId: string;
  peerKind: PeerKind;
  /** Người viết. Trong nhóm thì KHÁC threadId. */
  senderId: string;
  senderName: string | null;
  senderAvatar: string | null;
  content: string;
  attachments: Attachment[];
  msgId: string;
  /** `{threadId}:{msgId}` — msgId của Telegram chỉ duy nhất TRONG một hội thoại. */
  dedupKey: string;
  direction: Direction;
  replyToMsgId: string | null;
  timestamp: number;
  /** Có ở payload do listener dựng (không có ở toInboundPayload trần). */
  threadName?: string | null;
  threadAvatar?: string | null;
  /** Đặt khi tin đến từ một lần nạp lịch sử, không phải realtime. */
  isHistory?: boolean;
}

// ── Đồng bộ ─────────────────────────────────────────────────────────────────

export interface DialogSummary {
  threadId: string | null;
  kind: PeerKind;
  name: string | null;
  username: string | null;
  phone: string | null;
  avatarUrl: string | null;
  unreadCount: number;
  lastMessageAt: number | null;
}

export interface SyncSummary {
  dialogsScanned: number;
  dialogsSynced: number;
  dialogsSkipped: number;
  messagesPushed: number;
  messagesFailed: number;
}

export interface RestoreSummary {
  total: number;
  restored: number;
  failed: number;
}
