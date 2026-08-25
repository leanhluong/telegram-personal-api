import { describePeer, peerKindOf, idToString } from './peers.js';
import { buildPayload, pushInbound } from './listener.js';
import { errMsg } from './errors.js';
import type { Config, DialogSummary, SyncSummary, TgClient, TgRaw } from './types.js';

/**
 * Nạp lịch sử — thứ mà đường Telegram Bot <b>vĩnh viễn không làm được</b>.
 *
 * Một con bot chỉ thấy tin gửi cho chính nó, kể từ lúc bật webhook trở đi. Đăng nhập bằng tài khoản
 * thật thì toàn bộ lịch sử nằm sẵn trên máy chủ Telegram và lấy về được. Đây chính là khác biệt mà
 * người dùng nhìn thấy giữa hộp thư trống và hộp thư có nội dung.
 *
 * <b>Kéo theo thứ tự cũ → mới.</b> Telegram trả tin mới nhất trước; đẩy nguyên thứ tự đó thì
 * upstream dựng hội thoại với mốc bắt đầu lộn ngược và luồng tin hiện ra đảo đầu.
 */

/** Một hội thoại trong danh sách, đủ để upstream dựng liên hệ. */
function describeDialog(cfg: Config, accountId: string, dialog: TgRaw): DialogSummary {
  const entity: TgRaw = dialog.entity;
  const kind = peerKindOf(entity);
  const peer = describePeer(cfg, accountId, entity);
  return {
    threadId: peer.peerId,
    kind,
    name: peer.displayName,
    username: peer.username,
    phone: peer.phone,
    avatarUrl: peer.avatarUrl,
    unreadCount: dialog.unreadCount ?? 0,
    lastMessageAt: dialog.message?.date ? dialog.message.date * 1000 : null,
  };
}

/** Liệt kê hội thoại. Bỏ qua mục không dựng được thực thể thay vì làm hỏng cả lần đồng bộ. */
export async function listDialogs(
  cfg: Config, client: TgClient, accountId: string, { limit }: { limit?: number } = {},
): Promise<DialogSummary[]> {
  const dialogs: TgRaw[] = await client.getDialogs({ limit: limit ?? cfg.syncDialogLimit });
  const out: DialogSummary[] = [];
  for (const d of dialogs) {
    if (!d?.entity || !idToString(d.entity.id)) continue;
    out.push(describeDialog(cfg, accountId, d));
  }
  return out;
}

export interface SyncOptions {
  dialogLimit?: number;
  messageLimit?: number;
  kinds?: string[];
}

/**
 * Đồng bộ lịch sử của một tài khoản về upstream.
 *
 * Trả về bản tổng kết ĐẾM ĐƯỢC — bao nhiêu hội thoại quét, bao nhiêu tin đẩy, bao nhiêu tin đẩy
 * hỏng. Trả "đã đồng bộ xong" trống rỗng thì lần chạy nuốt sạch lỗi trông y hệt lần chạy thành
 * công.
 */
export async function syncHistory(
  cfg: Config, client: TgClient, accountId: string,
  { dialogLimit, messageLimit, kinds = ['user', 'bot', 'group'] }: SyncOptions = {},
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    dialogsScanned: 0, dialogsSynced: 0, dialogsSkipped: 0,
    messagesPushed: 0, messagesFailed: 0,
  };

  const dialogs: TgRaw[] = await client.getDialogs({ limit: dialogLimit ?? cfg.syncDialogLimit });

  for (const dialog of dialogs) {
    summary.dialogsScanned++;
    const entity: TgRaw = dialog?.entity;
    const threadId = idToString(entity?.id);
    if (!threadId) { summary.dialogsSkipped++; continue; }

    // Kênh phát một chiều mặc định bị loại: chúng là bản tin, không phải hội thoại của khách. Kéo
    // về là hộp thư ngập bài đăng và con số "chưa trả lời" mất hết ý nghĩa.
    if (!kinds.includes(peerKindOf(entity))) { summary.dialogsSkipped++; continue; }

    let messages: TgRaw[];
    try {
      messages = await client.getMessages(entity, { limit: messageLimit ?? cfg.syncMessageLimit });
    } catch (err) {
      console.warn(`[sync] không đọc được tin của thread=${threadId}: ${errMsg(err)}`);
      summary.dialogsSkipped++;
      continue;
    }

    // Telegram trả mới nhất trước — đảo lại trước khi đẩy. Xem ghi chú đầu file.
    for (const msg of [...messages].reverse()) {
      if (!msg?.id) continue;
      try {
        const payload = await buildPayload(cfg, client, accountId, msg, entity);
        if (!payload) continue;
        const ok = await pushInbound(cfg, { ...payload, isHistory: true });
        if (ok) summary.messagesPushed++; else summary.messagesFailed++;
      } catch (err) {
        console.warn(`[sync] dựng tin lỗi thread=${threadId} msg=${msg.id}: ${errMsg(err)}`);
        summary.messagesFailed++;
      }
    }
    summary.dialogsSynced++;
  }

  console.log(`[sync] account=${accountId} — ${JSON.stringify(summary)}`);
  return summary;
}
