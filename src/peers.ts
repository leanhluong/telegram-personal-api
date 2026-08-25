import type {
  Config, PeerDescriptor, PeerKind, SelfDescriptor, TgClient, TgRaw,
} from './types.js';

/**
 * Chuyển thực thể Telegram (người dùng / nhóm / kênh) thành hình dạng upstream hiểu được.
 *
 * <b>Ảnh đại diện Telegram không có URL công khai.</b> Khác Zalo và Facebook — nơi CDN trả về một
 * đường dẫn http dán thẳng vào thẻ ảnh là xong — ảnh Telegram chỉ tải được qua một phiên đã đăng
 * nhập. Vì vậy ở đây chỉ dựng một đường dẫn TRỎ VỀ CHÍNH SERVICE NÀY; upstream gọi vào đó rồi sao
 * lưu sang kho của mình. Trả thẳng chuỗi base64 vào cơ sở dữ liệu thì cột avatar phình lên vài
 * chục KB mỗi dòng.
 */

/** Telegram trả id dạng BigInteger; mọi nơi ngoài đây dùng chuỗi. */
export function idToString(id: unknown): string | null {
  if (id === null || id === undefined) return null;
  return typeof id === 'object' && typeof (id as TgRaw).toString === 'function'
    ? (id as TgRaw).toString()
    : String(id);
}

/** Tên hiển thị: người dùng ghép họ tên, nhóm/kênh lấy tiêu đề, cùng đường thì lấy @username. */
export function displayNameOf(entity: TgRaw): string | null {
  if (!entity) return null;
  if (entity.title) return entity.title;                       // nhóm, kênh
  const full = [entity.firstName, entity.lastName].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (entity.username) return `@${entity.username}`;
  return null;
}

/** Loại hội thoại — upstream cần phân biệt chat riêng với nhóm. */
export function peerKindOf(entity: TgRaw): PeerKind {
  if (!entity) return 'unknown';
  if (entity.className === 'User') return entity.bot ? 'bot' : 'user';
  if (entity.className === 'Chat' || entity.className === 'ChatForbidden') return 'group';
  if (entity.className === 'Channel' || entity.className === 'ChannelForbidden') {
    return entity.megagroup ? 'group' : 'channel';
  }
  return 'unknown';
}

/**
 * Đường dẫn ảnh đại diện do service phục vụ.
 *
 * Trả <c>null</c> khi thực thể không có ảnh — dựng đường dẫn cho một thứ không tồn tại chỉ khiến
 * upstream tải về 404 rồi ghi log lỗi cho mọi liên hệ chưa đặt ảnh, tức phần lớn liên hệ.
 */
export function avatarUrlOf(cfg: Config, accountId: string, entity: TgRaw): string | null {
  if (!entity || !entity.photo) return null;
  const peerId = idToString(entity.id);
  if (!peerId) return null;
  return `${cfg.publicBaseUrl.replace(/\/+$/, '')}/avatars/${encodeURIComponent(accountId)}/${encodeURIComponent(peerId)}`;
}

/** Mô tả chủ tài khoản vừa đăng nhập. */
export async function describeSelf(client: TgClient, user?: TgRaw): Promise<SelfDescriptor> {
  const me: TgRaw = user ?? (await client.getMe());
  return {
    accountId: idToString(me?.id),
    displayName: displayNameOf(me) ?? 'Telegram',
    username: me?.username ?? null,
    phone: me?.phone ?? null,
    // Ảnh của CHÍNH chủ tài khoản dựng sau, ở tầng gọi — lúc này accountId mới vừa có.
    avatarUrl: null,
  };
}

/** Mô tả một đối tác hội thoại để upstream dựng liên hệ. */
export function describePeer(cfg: Config, accountId: string, entity: TgRaw): PeerDescriptor {
  return {
    peerId: idToString(entity?.id),
    kind: peerKindOf(entity),
    displayName: displayNameOf(entity),
    username: entity?.username ?? null,
    phone: entity?.phone ?? null,
    avatarUrl: avatarUrlOf(cfg, accountId, entity),
  };
}

/**
 * Tải ảnh đại diện. Trả <c>null</c> khi không có — <b>không ném</b>.
 *
 * Liên hệ không có ảnh là chuyện thường; biến nó thành lỗi thì mọi lời gọi đều kèm một dòng log
 * hoảng hốt và đường ảnh trả 500 thay vì 404 đọc được.
 */
export async function downloadAvatar(client: TgClient, entity: TgRaw): Promise<Buffer | null> {
  try {
    const buf = await client.downloadProfilePhoto(entity, { isBig: false });
    if (!buf || buf.length === 0) return null;
    return Buffer.from(buf as Buffer);
  } catch (err) {
    console.warn('[peers] tải ảnh đại diện lỗi:', (err as Error)?.message);
    return null;
  }
}
