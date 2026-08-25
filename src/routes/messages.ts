import express from 'express';
import bigInt from 'big-integer';
import { Api } from 'telegram';
import { CustomFile } from 'telegram/client/uploads.js';
import { getSessionByAccountId, Status } from '../sessionStore.js';
import { errMsg } from '../errors.js';
import type { Config, SessionRecord, TgClient, TgRaw } from '../types.js';

/**
 * Gửi tin đi.
 *
 * <h3>Cái bẫy "không tra được đối tác"</h3>
 *
 * MTProto không nhận id trần — nó cần <i>input peer</i> gồm id kèm access hash, và access hash chỉ
 * có sau khi phiên đã từng nhìn thấy đối tác đó. Ngay sau khi service khởi động lại, bộ nhớ đó có
 * thể rỗng và lời gọi gửi tin chết với <c>Could not find the input entity</c> — dù phiên hoàn toàn
 * khoẻ mạnh.
 *
 * Nên khi tra hỏng, ta nạp danh sách hội thoại một lần để hâm nóng bộ nhớ rồi thử lại. Không có
 * lưới đỡ này thì mỗi lần triển khai lại là một khoảng thời gian nhân viên bấm gửi và tin không đi,
 * trong khi mọi chỉ số đều xanh.
 */

/** Phiên đã ĐẢM BẢO có client — nói ra trong kiểu để call site khỏi kiểm null lại. */
type LiveSession = SessionRecord & { client: TgClient };

async function resolveEntity(client: TgClient, threadId: string): Promise<TgRaw> {
  const id = bigInt(String(threadId));
  try {
    return await client.getEntity(id);
  } catch (first) {
    console.warn(`[send] chưa biết đối tác ${threadId} (${errMsg(first)}) — nạp hội thoại rồi thử lại`);
    try {
      await client.getDialogs({ limit: 200 });
      return await client.getEntity(id);
    } catch (second) {
      throw new Error(
        `Không tra được hội thoại ${threadId}: ${errMsg(second)}. ` +
        `Tài khoản này có thể chưa từng nhắn với đối tác đó.`);
    }
  }
}

function requireLiveSession(res: express.Response, accountId: string): LiveSession | null {
  const session = getSessionByAccountId(accountId);
  if (!session) {
    res.status(404).json({ error: 'Không tìm thấy phiên — cần quét QR lại' });
    return null;
  }
  if (session.status !== Status.Confirmed || !session.client) {
    res.status(503).json({ error: `Phiên chưa sẵn sàng (status=${session.status})` });
    return null;
  }
  return session as LiveSession;
}

export function messagesRouter(_cfg: Config): express.Router {
  const router = express.Router();

  /**
   * POST /sessions/:accountId/send-text
   * body { threadId, text, replyToMsgId? }
   */
  router.post('/:accountId/send-text', async (req, res) => {
    const { accountId } = req.params;
    const { threadId, text, replyToMsgId } = req.body ?? {};

    if (!threadId || typeof text !== 'string' || text.length === 0) {
      return res.status(400).json({ error: 'Cần threadId và text' });
    }

    const session = requireLiveSession(res, accountId);
    if (!session) return undefined;

    try {
      const entity = await resolveEntity(session.client, threadId);
      const sent: TgRaw = await session.client.sendMessage(entity, {
        message: text,
        ...(replyToMsgId ? { replyTo: Number(replyToMsgId) } : {}),
      });

      const msgId = String(sent?.id ?? '');
      console.log(`[send] account=${accountId} thread=${threadId} msgId=${msgId} len=${text.length}`);
      // Trả lại khoá khử trùng để upstream ghim đúng tin vừa gửi — trình nghe cũng sẽ nhận lại
      // chính tin này (chiều gửi đi), và không có khoá thì nó vào hộp thư lần thứ hai.
      return res.json({ msgId, dedupKey: `${threadId}:${msgId}` });
    } catch (err) {
      const msg = errMsg(err);
      console.error(`[send] account=${accountId} thread=${threadId} lỗi: ${msg}`);
      // 502, không 500: hỏng nằm ở phía Telegram chứ không phải service. Upstream phân biệt được
      // để quyết định có thử lại hay không.
      return res.status(502).json({ error: msg });
    }
  });

  /**
   * POST /sessions/:accountId/send-file
   * body { threadId, fileUrl, fileName, mimeType?, caption?, replyToMsgId?, kind? }
   *
   * <h3>Vì sao tải về rồi mới tải lên, thay vì đưa thẳng URL</h3>
   *
   * MTProto không nhận URL — khác Bot API. Tệp phải nằm trong bộ nhớ rồi tải lên qua
   * <c>CustomFile</c>. URL upstream gửi sang thường là liên kết ký sẵn có hạn, nên phải lấy về
   * NGAY trong lời gọi này; đẩy sang hàng đợi để "tối ưu" là lúc chạy thật thì liên kết đã hết hạn.
   *
   * <c>kind</c> quyết định Telegram hiển thị thế nào: ảnh/video hiện trong khung chat, còn
   * <c>file</c> thì buộc thành tệp đính kèm. Gửi ảnh mà quên cờ này thì nó hiện ra như một tệp
   * .jpg phải bấm tải về — vẫn "gửi thành công", chỉ là khách phải thao tác thêm.
   */
  router.post('/:accountId/send-file', async (req, res) => {
    const { accountId } = req.params;
    const { threadId, fileUrl, fileName, mimeType, caption, replyToMsgId, kind } = req.body ?? {};

    if (!threadId || !fileUrl) {
      return res.status(400).json({ error: 'Cần threadId và fileUrl' });
    }

    const session = requireLiveSession(res, accountId);
    if (!session) return undefined;

    try {
      const download = await fetch(fileUrl);
      if (!download.ok) {
        // Phân biệt rõ: hỏng ở bước LẤY tệp của mình, không phải Telegram từ chối. 502 chung sẽ
        // khiến người đọc log đi tìm nhầm phía Telegram.
        console.error(`[send-file] account=${accountId} không tải được tệp: HTTP ${download.status}`);
        return res.status(502).json({
          error: `Không tải được tệp từ kho (HTTP ${download.status}) — liên kết có thể đã hết hạn`,
        });
      }

      const buffer = Buffer.from(await download.arrayBuffer());
      const name = fileName || `file_${Date.now()}`;
      const file = new CustomFile(name, buffer.length, '', buffer);

      const sent: TgRaw = await session.client.sendFile(
        await resolveEntity(session.client, threadId),
        {
          file,
          caption: typeof caption === 'string' && caption.length > 0 ? caption : undefined,
          // `image`/`video` → hiện trong khung chat; mọi loại khác → tệp đính kèm.
          forceDocument: kind !== 'image' && kind !== 'video',
          ...(replyToMsgId ? { replyTo: Number(replyToMsgId) } : {}),
        },
      );

      const msgId = String(sent?.id ?? '');
      console.log(
        `[send-file] account=${accountId} thread=${threadId} msgId=${msgId} ` +
        `bytes=${buffer.length} kind=${kind ?? 'file'} mime=${mimeType ?? '?'}`);
      return res.json({ msgId, dedupKey: `${threadId}:${msgId}` });
    } catch (err) {
      const msg = errMsg(err);
      console.error(`[send-file] account=${accountId} thread=${threadId} lỗi: ${msg}`);
      return res.status(502).json({ error: msg });
    }
  });

  /**
   * POST /sessions/:accountId/typing
   * body { threadId }
   *
   * Telegram tự tắt chỉ báo sau ~6 giây, nên KHÔNG có đường tắt riêng: cứ gõ tiếp thì upstream gọi
   * lại. Thêm một đường "typing_off" ở đây là mã chết — không ai gọi được nó đúng lúc.
   */
  router.post('/:accountId/typing', async (req, res) => {
    const { accountId } = req.params;
    const { threadId } = req.body ?? {};
    if (!threadId) return res.status(400).json({ error: 'Cần threadId' });

    const session = requireLiveSession(res, accountId);
    if (!session) return undefined;

    try {
      const entity = await resolveEntity(session.client, threadId);
      await session.client.invoke(new Api.messages.SetTyping({
        peer: entity,
        action: new Api.SendMessageTypingAction(),
      }));
      return res.json({ ok: true });
    } catch (err) {
      const msg = errMsg(err);
      console.error(`[typing] account=${accountId} thread=${threadId} lỗi: ${msg}`);
      return res.status(502).json({ error: msg });
    }
  });

  /**
   * POST /sessions/:accountId/react
   * body { threadId, msgId, emoji }   — emoji rỗng/thiếu = GỠ cảm xúc
   *
   * Telegram dùng CÙNG một lời gọi cho thả, đổi và gỡ: danh sách rỗng nghĩa là gỡ. Tách thành hai
   * đường ở đây chỉ để trông đối xứng sẽ khiến hai đường trôi lệch nhau về sau.
   */
  router.post('/:accountId/react', async (req, res) => {
    const { accountId } = req.params;
    const { threadId, msgId, emoji } = req.body ?? {};
    if (!threadId || !msgId) return res.status(400).json({ error: 'Cần threadId và msgId' });

    const session = requireLiveSession(res, accountId);
    if (!session) return undefined;

    try {
      const entity = await resolveEntity(session.client, threadId);
      await session.client.invoke(new Api.messages.SendReaction({
        peer: entity,
        msgId: Number(msgId),
        reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
      }));
      console.log(`[react] account=${accountId} thread=${threadId} msg=${msgId} emoji=${emoji || '(gỡ)'}`);
      return res.json({ ok: true });
    } catch (err) {
      const msg = errMsg(err);
      console.error(`[react] account=${accountId} thread=${threadId} lỗi: ${msg}`);
      return res.status(502).json({ error: msg });
    }
  });

  /**
   * POST /sessions/:accountId/unsend
   * body { threadId, msgId }
   *
   * <c>revoke: true</c> = thu hồi ở CẢ HAI phía. Bỏ cờ đó thì tin chỉ biến mất khỏi máy mình còn
   * khách vẫn đọc được — đúng thứ người bấm "thu hồi" tưởng đã tránh được.
   */
  router.post('/:accountId/unsend', async (req, res) => {
    const { accountId } = req.params;
    const { threadId, msgId } = req.body ?? {};
    if (!threadId || !msgId) return res.status(400).json({ error: 'Cần threadId và msgId' });

    const session = requireLiveSession(res, accountId);
    if (!session) return undefined;

    try {
      const entity = await resolveEntity(session.client, threadId);
      await session.client.deleteMessages(entity, [Number(msgId)], { revoke: true });
      console.log(`[unsend] account=${accountId} thread=${threadId} msg=${msgId}`);
      return res.json({ ok: true });
    } catch (err) {
      const msg = errMsg(err);
      console.error(`[unsend] account=${accountId} thread=${threadId} lỗi: ${msg}`);
      return res.status(502).json({ error: msg });
    }
  });

  /**
   * POST /sessions/:accountId/mark-read
   * body { threadId }
   */
  router.post('/:accountId/mark-read', async (req, res) => {
    const { accountId } = req.params;
    const { threadId } = req.body ?? {};
    if (!threadId) return res.status(400).json({ error: 'Cần threadId' });

    const session = requireLiveSession(res, accountId);
    if (!session) return undefined;

    try {
      const entity = await resolveEntity(session.client, threadId);
      await session.client.markAsRead(entity);
      return res.json({ ok: true });
    } catch (err) {
      const msg = errMsg(err);
      console.error(`[mark-read] account=${accountId} thread=${threadId} lỗi: ${msg}`);
      return res.status(502).json({ error: msg });
    }
  });

  return router;
}
