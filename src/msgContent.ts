import { idToString } from './peers.js';
import type {
  Attachment, AttachmentType, Config, InboundPayload, PeerDescriptor, PeerKind, TgRaw,
} from './types.js';

/**
 * Quy tin nhắn Telegram về hình dạng upstream dùng.
 *
 * <h3>Hai cái bẫy về định danh, cả hai đều hỏng trong im lặng</h3>
 *
 * <b>1. <c>message.id</c> chỉ duy nhất TRONG MỘT hội thoại.</b> Hai người lạ cùng nhắn tin đầu tiên
 * thì cả hai tin đều mang <c>id = 1</c>. Khử trùng bằng riêng nó là nuốt mất tin thứ hai — không
 * lỗi, không log, chỉ là một tin của khách biến mất. Khoá đúng là <c>{peerId}:{messageId}</c>.
 *
 * <b>2. <c>peerId</c> của tin trong nhóm là NHÓM, không phải người gửi.</b> Lấy nhầm thì mọi tin
 * trong một nhóm gộp về một liên hệ mang tên nhóm, và câu trả lời đi thẳng vào nhóm — hiện ra với
 * tất cả thành viên. Nên <c>threadId</c> (hội thoại) và <c>senderId</c> (người viết) tách bạch.
 */

/** Đường tải tệp đính kèm — do service phục vụ, vì Telegram không có URL công khai (xem peers.ts). */
function mediaUrl(cfg: Config, accountId: string, threadId: string, messageId: number | string): string {
  const base = cfg.publicBaseUrl.replace(/\/+$/, '');
  return `${base}/media/${encodeURIComponent(accountId)}/${encodeURIComponent(threadId)}/${encodeURIComponent(String(messageId))}`;
}

interface DocumentMeta {
  fileName: string | null;
  isVoice: boolean;
  isVideo: boolean;
  isSticker: boolean;
  isAnimated: boolean;
}

function documentAttributes(doc: TgRaw): DocumentMeta {
  const attrs: TgRaw[] = doc?.attributes ?? [];
  const out: DocumentMeta = {
    fileName: null, isVoice: false, isVideo: false, isSticker: false, isAnimated: false,
  };
  for (const a of attrs) {
    switch (a.className) {
      case 'DocumentAttributeFilename': out.fileName = a.fileName; break;
      case 'DocumentAttributeAudio': if (a.voice) out.isVoice = true; break;
      case 'DocumentAttributeVideo': out.isVideo = true; break;
      case 'DocumentAttributeSticker': out.isSticker = true; break;
      case 'DocumentAttributeAnimated': out.isAnimated = true; break;
      default: break;
    }
  }
  return out;
}

/**
 * Bóc tệp đính kèm.
 *
 * Loại chưa nhận ra được vẫn trả về một mục mang <c>type: 'unknown'</c> kèm <c>className</c> thật.
 * Bỏ qua trong im lặng thì tin hiện ra rỗng không và không còn cách nào biết Telegram vừa gửi cái
 * gì — mất luôn cơ hội đọc ra hình dạng thật.
 */
export function extractAttachments(
  cfg: Config, msg: TgRaw, accountId: string, threadId: string,
): Attachment[] {
  const media: TgRaw = msg?.media;
  if (!media) return [];

  const url = mediaUrl(cfg, accountId, threadId, msg.id);

  if (media.className === 'MessageMediaPhoto') {
    return [{ type: 'image', url, name: `photo_${msg.id}.jpg`, mimeType: 'image/jpeg' }];
  }

  if (media.className === 'MessageMediaDocument') {
    const doc: TgRaw = media.document;
    const meta = documentAttributes(doc);
    const mimeType: string = doc?.mimeType ?? 'application/octet-stream';
    let type: AttachmentType = 'file';
    if (meta.isVoice) type = 'audio';
    else if (meta.isSticker) type = 'sticker';
    else if (meta.isVideo || meta.isAnimated) type = 'video';
    else if (mimeType.startsWith('image/')) type = 'image';
    else if (mimeType.startsWith('audio/')) type = 'audio';
    else if (mimeType.startsWith('video/')) type = 'video';

    return [{
      type,
      url,
      name: meta.fileName ?? `${type}_${msg.id}`,
      mimeType,
      size: doc?.size !== undefined ? Number(doc.size) : null,
    }];
  }

  // Bản xem trước liên kết KHÔNG phải tệp đính kèm — chính văn bản đã mang liên kết rồi. Coi nó là
  // đính kèm thì mỗi tin có link lại đẻ thêm một "tệp" giả trong hộp thư.
  if (media.className === 'MessageMediaWebPage') return [];

  if (media.className === 'MessageMediaGeo' || media.className === 'MessageMediaGeoLive') {
    const geo: TgRaw = media.geo;
    if (geo?.className !== 'GeoPoint') return [];
    return [{ type: 'location', latitude: geo.lat, longitude: geo.long }];
  }

  if (media.className === 'MessageMediaContact') {
    return [{
      type: 'contact',
      name: [media.firstName, media.lastName].filter(Boolean).join(' ').trim() || null,
      phone: media.phoneNumber ?? null,
    }];
  }

  return [{ type: 'unknown', className: media.className, url }];
}

/** Văn bản hiển thị. Tin chỉ có ảnh thì rỗng — upstream tự dựng nhãn theo tệp đính kèm. */
export function extractText(msg: TgRaw): string {
  if (typeof msg?.message === 'string' && msg.message.length > 0) return msg.message;
  if (msg?.action) return ''; // tin hệ thống (thêm người, đổi ảnh nhóm...)
  return '';
}

export interface ToInboundArgs {
  msg: TgRaw;
  accountId: string;
  threadId: string;
  peerKind: PeerKind;
  /** Vắng khi tầng gọi chưa tra được đối tác — payload vẫn dựng được, chỉ thiếu tên/ảnh. */
  sender?: PeerDescriptor | null;
}

/**
 * Chuyển một <c>Api.Message</c> thành phần thân upstream nhận.
 *
 * <c>threadId</c> phải do tầng gọi truyền vào: chỉ ở đó mới biết chắc hội thoại nào, còn suy ra từ
 * <c>peerId</c> của tin thì tin do chính mình gửi trong chat riêng lại trỏ về người nhận hay chính
 * mình tuỳ hoàn cảnh.
 */
export function toInboundPayload(
  cfg: Config, { msg, accountId, threadId, peerKind, sender }: ToInboundArgs,
): InboundPayload {
  const isOutgoing = msg.out === true;
  return {
    accountId,
    threadId,
    peerKind,
    // Người viết. Chat riêng thì trùng threadId; trong nhóm thì KHÁC — xem bẫy (2) đầu file.
    senderId: idToString(msg.fromId?.userId ?? msg.senderId) ?? threadId,
    senderName: sender?.displayName ?? null,
    senderAvatar: sender?.avatarUrl ?? null,
    content: extractText(msg),
    attachments: extractAttachments(cfg, msg, accountId, threadId),
    msgId: String(msg.id),
    // Khoá khử trùng. Xem bẫy (1) đầu file về vì sao KHÔNG được dùng riêng msgId.
    dedupKey: `${threadId}:${msg.id}`,
    direction: isOutgoing ? 'Out' : 'In',
    replyToMsgId: msg.replyTo?.replyToMsgId !== undefined ? String(msg.replyTo.replyToMsgId) : null,
    // Telegram tính bằng giây; upstream dùng mili giây.
    timestamp: (msg.date ?? Math.floor(Date.now() / 1000)) * 1000,
  };
}
