import express from 'express';
import {
  getSession, getSessionByAccountId, deleteSession, listSessions, Status,
} from '../sessionStore.js';
import { startQrLogin, submitPassword } from '../qrLogin.js';
import { registerListener } from '../listener.js';
import { errMsg } from '../errors.js';
import type { Config } from '../types.js';

/** Thời gian tối đa chờ Telegram trả lời lệnh thăm dò. */
const PROBE_TIMEOUT_MS = 6000;

export function sessionsRouter(cfg: Config): express.Router {
  const router = express.Router();

  /**
   * POST /sessions/init-qr — mở một phiên đăng nhập, trả về tấm QR đầu tiên.
   */
  router.post('/init-qr', async (req, res) => {
    try {
      const { tempAccountId } = req.body ?? {};
      const result = await startQrLogin(cfg, {
        tempAccountId,
        // Gắn trình nghe NGAY khi đăng nhập xong, không đợi upstream hỏi. Chờ thêm một vòng gọi
        // nữa là có một khoảng trống mà tin đến rơi thẳng xuống đất.
        onReady: async (session) => {
          if (session?.client && session.accountId) {
            registerListener(cfg, session.client, session.accountId, { tag: 'qr' });
          }
        },
      });
      console.log(`[init-qr] sẵn sàng — qrToken=${result.qrToken}`);
      res.json(result);
    } catch (err) {
      console.error('[init-qr] lỗi:', errMsg(err));
      res.status(500).json({ error: errMsg(err) });
    }
  });

  /**
   * GET /sessions/:qrToken/status
   *
   * Trả kèm <c>qrImageUrl</c> vì <b>mã QR đổi khoảng 30 giây một lần</b>. Màn hình phải vẽ lại theo
   * tấm mới nhất; giữ tấm đầu tiên là người dùng quét phải một mã đã chết và app chỉ báo "mã không
   * hợp lệ" mà không nói vì sao.
   */
  router.get('/:qrToken/status', (req, res) => {
    const session = getSession(req.params.qrToken);
    if (!session) return res.status(404).json({ error: 'Không tìm thấy phiên hoặc phiên đã hết hạn' });

    return res.json({
      status: session.status,
      accountId: session.accountId,
      displayName: session.displayName,
      username: session.username,
      phone: session.phone,
      avatarUrl: session.avatarUrl,
      sessionString: session.sessionString,
      qrImageUrl: session.qrImageUrl,
      passwordHint: session.passwordHint,
      errorReason: session.errorReason,
    });
  });

  /**
   * POST /sessions/:qrToken/password — nộp mật khẩu hai lớp.
   *
   * Chỉ tài khoản có bật mật khẩu hai lớp mới đi qua đây. Không có bước này thì những tài khoản đó
   * vĩnh viễn không kết nối được, và màn hình chỉ đứng im ở "đang chờ".
   */
  router.post('/:qrToken/password', (req, res) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: 'Thiếu mật khẩu' });
    }

    const result = submitPassword(req.params.qrToken, password);
    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404 : 409;
      const message = result.reason === 'not_found'
        ? 'Không tìm thấy phiên hoặc phiên đã hết hạn'
        : 'Phiên này không đang chờ mật khẩu';
      return res.status(code).json({ error: message });
    }
    // KHÔNG khẳng định "đúng mật khẩu" ở đây — mới chỉ chuyển được chuỗi cho Telegram. Đúng hay sai
    // phải đọc ở /status: sai thì trạng thái thành password_invalid và Telegram hỏi lại.
    return res.json({ accepted: true });
  });

  /**
   * GET /sessions/:accountId/health
   *
   * Hai tầng bằng chứng, cố ý không suy diễn:
   *   1. <c>lastEventAt</c> — lần cuối Telegram đẩy về bất cứ thứ gì.
   *   2. <c>probe</c> — gọi thật lên Telegram.
   *
   * Suy ra "còn sống" từ việc đã đăng nhập thành công là cách hỏng kinh điển: nó đúng vĩnh viễn kể
   * cả sau khi đường đã đứt hàng giờ.
   */
  router.get('/:accountId/health', async (req, res) => {
    const { accountId } = req.params;
    const session = getSessionByAccountId(accountId);

    if (!session || session.status !== Status.Confirmed || !session.client) {
      return res.json({
        healthy: false,
        registered: false,
        connected: false,
        reason: session === null || session === undefined ? 'no_session' : `status=${session.status}`,
      });
    }

    const client = session.client;
    let probeOk = false;
    let probeError: string | null = null;
    try {
      await Promise.race([
        client.getMe(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT_MS)),
      ]);
      probeOk = true;
    } catch (err) {
      probeError = errMsg(err);
    }

    const lastEventAt = session.lastEventAt ?? null;
    const body = {
      healthy: probeOk,
      registered: true,
      connected: client.connected === true,
      lastEventAt,
      secondsSinceLastEvent: lastEventAt ? Math.round((Date.now() - lastEventAt) / 1000) : null,
      probeError,
    };
    console.log(`[health] account=${accountId} healthy=${body.healthy} connected=${body.connected}` +
      (probeError ? ` probeError="${probeError}"` : ''));
    return res.json(body);
  });

  /** GET /sessions — chẩn đoán. */
  router.get('/', (_req, res) => res.json({ sessions: listSessions() }));

  /** DELETE /sessions/:accountId — ngắt kết nối. */
  router.delete('/:accountId', async (req, res) => {
    const removed = await deleteSession(req.params.accountId);
    console.log(`[delete-session] account=${req.params.accountId} — bỏ ${removed} phiên`);
    res.status(204).send();
  });

  return router;
}
