import { NewMessage } from 'telegram/events/index.js';
import { touchSession, markConnState } from './sessionStore.js';
import { describePeer, peerKindOf, idToString } from './peers.js';
import { toInboundPayload } from './msgContent.js';
import { errMsg } from './errors.js';
import type { Config, InboundPayload, PeerDescriptor, TgClient, TgRaw } from './types.js';

/**
 * Nghe tin đến và đẩy về upstream.
 *
 * <h3>Về việc mất tin</h3>
 *
 * Đường đẩy dưới đây <b>không có hàng đợi, không thử lại</b>. Nhưng hậu quả nhẹ hơn hẳn so với các
 * nền tảng khác: Telegram giữ toàn bộ lịch sử trên máy chủ của họ, nên tin trượt lúc upstream đang
 * khởi động lại <b>lấy lại được</b> bằng một lần đồng bộ (<c>sync.ts</c>).
 *
 * Điều đó không biến việc mất tin thành chuyện vô hại — nó chỉ có nghĩa là <b>có đường sửa</b>.
 * Đẩy hỏng được ghi log kèm khoá khử trùng để đối chiếu về sau.
 */

function pushUrl(cfg: Config, path: string): string {
  return `${cfg.upstreamBaseUrl.replace(/\/+$/, '')}${cfg.upstreamWebhookPath}${path}`;
}

interface PushMeta {
  what: string;
  detail: string;
}

async function push(cfg: Config, path: string, payload: unknown, { what, detail }: PushMeta): Promise<boolean> {
  try {
    const resp = await fetch(pushUrl(cfg, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-System-Key': cfg.systemKey },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.error(`[listener] ${what} lỗi HTTP ${resp.status} — ${detail}. ` +
        `Tin còn trên máy chủ Telegram, đồng bộ lại lấy về được.`);
      return false;
    }
    console.log(`[listener] ${what} OK [${resp.status}] ${detail}`);
    return true;
  } catch (err) {
    console.error(`[listener] ${what} lỗi: ${errMsg(err)} — ${detail}. ` +
      `Tin còn trên máy chủ Telegram, đồng bộ lại lấy về được.`);
    return false;
  }
}

export const pushInbound = (cfg: Config, payload: InboundPayload): Promise<boolean> =>
  push(cfg, '', payload, {
    what: 'pushInbound',
    detail: `dedupKey=${payload.dedupKey} direction=${payload.direction}`,
  });

/**
 * Dựng phần thân đẩy về upstream cho một tin.
 *
 * Tách riêng khỏi trình nghe vì đồng bộ lịch sử dùng lại đúng hàm này — hai đường mà mỗi đường một
 * bản chép là cách chắc chắn để chúng trôi lệch nhau.
 */
export async function buildPayload(
  cfg: Config, client: TgClient, accountId: string, msg: TgRaw, chatEntity?: TgRaw,
): Promise<InboundPayload | null> {
  const chat: TgRaw = chatEntity ?? (await msg.getChat().catch(() => null));
  const threadId = idToString(chat?.id);
  if (!threadId) return null;

  const kind = peerKindOf(chat);

  // Trong nhóm, người viết khác hội thoại — phải hỏi riêng. Chat riêng thì đối tác CHÍNH là hội
  // thoại, khỏi tốn thêm một lời gọi.
  let sender: PeerDescriptor | null = null;
  if (kind === 'group' || kind === 'channel') {
    const senderEntity: TgRaw = await msg.getSender().catch(() => null);
    if (senderEntity) sender = describePeer(cfg, accountId, senderEntity);
  } else {
    sender = describePeer(cfg, accountId, chat);
  }

  return {
    ...toInboundPayload(cfg, { msg, accountId, threadId, peerKind: kind, sender }),
    threadName: kind === 'group' || kind === 'channel'
      ? (chat.title ?? null)
      : (sender?.displayName ?? null),
    threadAvatar: kind === 'group' || kind === 'channel'
      ? describePeer(cfg, accountId, chat).avatarUrl
      : (sender?.avatarUrl ?? null),
  };
}

/**
 * Gắn trình nghe cho một phiên đã đăng nhập.
 *
 * Dùng chung cho cả đường quét QR và đường khôi phục lúc khởi động — cố ý, xem ghi chú ở
 * {@link buildPayload}.
 */
export function registerListener(
  cfg: Config, client: TgClient, accountId: string, { tag = 'live' }: { tag?: string } = {},
): void {
  // Bắt CẢ tin đến lẫn tin chính chủ gửi từ điện thoại. Bỏ chiều gửi đi thì nhân viên trả lời bằng
  // app Telegram xong, hộp thư vẫn hiện hội thoại "chưa ai trả lời" — và luật SLA đếm sai.
  client.addEventHandler(async (event: TgRaw) => {
    try {
      touchSession(accountId);
      const payload = await buildPayload(cfg, client, accountId, event.message);
      if (!payload) return;
      console.log(`[${tag}] tin ${payload.direction} thread=${payload.threadId} msg=${payload.msgId}`);
      await pushInbound(cfg, payload);
    } catch (err) {
      console.error(`[${tag}] xử lý tin lỗi:`, errMsg(err));
    }
  }, new NewMessage({}));

  // Mọi cập nhật thô đều là bằng chứng đường truyền còn sống. /health đọc dấu thời gian này thay vì
  // suy ra từ "đã từng đăng nhập thành công" — thứ đúng vĩnh viễn kể cả khi đường đã đứt.
  client.addEventHandler(() => touchSession(accountId));

  markConnState(accountId, { connected: true });
  console.log(`[${tag}] đã gắn trình nghe cho account ${accountId}`);
}
