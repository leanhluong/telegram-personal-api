import express from 'express';
import bigInt from 'big-integer';
import { getSessionByAccountId, Status } from '../sessionStore.js';
import { downloadAvatar } from '../peers.js';
import { errMsg } from '../errors.js';
import type { Config, SessionRecord, TgClient, TgRaw } from '../types.js';

/**
 * Phục vụ ảnh đại diện và tệp đính kèm.
 *
 * <b>Vì sao service phải làm việc này:</b> Telegram không có URL công khai cho bất cứ tệp nào. Ảnh
 * và tệp chỉ tải được qua một phiên đã đăng nhập. Nên upstream gọi vào đây rồi sao lưu sang kho
 * của mình.
 *
 * <b>Đường dẫn này KHÔNG được ra Internet.</b> Bất kỳ ai gọi được cũng đọc được tệp riêng tư của
 * khách — service không xác thực request đến.
 */

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

type LiveSession = SessionRecord & { client: TgClient };

export function mediaRouter(_cfg: Config): express.Router {
  const router = express.Router();

  function liveSession(accountId: string): LiveSession | null {
    const s = getSessionByAccountId(accountId);
    return s && s.status === Status.Confirmed && s.client ? (s as LiveSession) : null;
  }

  /** GET /avatars/:accountId/:peerId */
  router.get('/avatars/:accountId/:peerId', async (req, res) => {
    const { accountId, peerId } = req.params;
    const session = liveSession(accountId);
    if (!session) return res.status(503).json({ error: 'Phiên chưa sẵn sàng' });

    try {
      const entity = await session.client.getEntity(bigInt(String(peerId)));
      const buf = await downloadAvatar(session.client, entity);
      // 404 chứ không 500: "liên hệ này chưa đặt ảnh" là chuyện thường, không phải sự cố. Trả 500
      // thì log của upstream đầy lỗi giả cho phần lớn liên hệ.
      if (!buf) return res.status(404).json({ error: 'Không có ảnh đại diện' });

      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(buf);
    } catch (err) {
      console.warn(`[avatar] account=${accountId} peer=${peerId} lỗi: ${errMsg(err)}`);
      return res.status(404).json({ error: 'Không lấy được ảnh đại diện' });
    }
  });

  /** GET /media/:accountId/:threadId/:messageId */
  router.get('/media/:accountId/:threadId/:messageId', async (req, res) => {
    const { accountId, threadId, messageId } = req.params;
    const session = liveSession(accountId);
    if (!session) return res.status(503).json({ error: 'Phiên chưa sẵn sàng' });

    try {
      const entity = await session.client.getEntity(bigInt(String(threadId)));
      const [msg] = await session.client.getMessages(entity, { ids: [Number(messageId)] }) as TgRaw[];
      if (!msg || !msg.media) return res.status(404).json({ error: 'Tin không có tệp đính kèm' });

      const doc: TgRaw = msg.media?.document;
      if (doc?.size !== undefined && Number(doc.size) > MAX_MEDIA_BYTES) {
        // Nói rõ đã bỏ qua vì kích thước. Cắt trong im lặng thì tệp lớn biến mất khỏi hộp thư mà
        // không ai biết vì sao.
        console.warn(`[media] bỏ qua tệp ${Number(doc.size)} byte > hạn ${MAX_MEDIA_BYTES} ` +
          `(account=${accountId} thread=${threadId} msg=${messageId})`);
        return res.status(413).json({ error: 'Tệp vượt quá kích thước cho phép' });
      }

      const buf = await session.client.downloadMedia(msg);
      if (!buf) return res.status(404).json({ error: 'Không tải được tệp' });

      res.set('Content-Type', doc?.mimeType ?? 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=3600');
      return res.send(Buffer.from(buf as Buffer));
    } catch (err) {
      console.warn(`[media] account=${accountId} thread=${threadId} msg=${messageId} lỗi: ${errMsg(err)}`);
      return res.status(404).json({ error: 'Không lấy được tệp' });
    }
  });

  return router;
}
