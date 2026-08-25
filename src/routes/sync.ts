import express from 'express';
import { getSessionByAccountId, Status } from '../sessionStore.js';
import { listDialogs, syncHistory } from '../sync.js';
import { errMsg } from '../errors.js';
import type { Config, SessionRecord, TgClient } from '../types.js';

type LiveSession = SessionRecord & { client: TgClient };

export function syncRouter(cfg: Config): express.Router {
  const router = express.Router();

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

  /** GET /sessions/:accountId/dialogs — danh sách hội thoại, để upstream dựng liên hệ. */
  router.get('/:accountId/dialogs', async (req, res) => {
    const session = requireLiveSession(res, req.params.accountId);
    if (!session) return;
    try {
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const dialogs = await listDialogs(cfg, session.client, req.params.accountId, { limit });
      res.json({ dialogs });
    } catch (err) {
      console.error(`[dialogs] account=${req.params.accountId} lỗi:`, errMsg(err));
      res.status(502).json({ error: errMsg(err) });
    }
  });

  /**
   * POST /sessions/:accountId/sync — nạp lịch sử về upstream.
   *
   * Trả về ngay và chạy nền: kéo 200 hội thoại × 50 tin vượt xa mọi hạn chờ HTTP hợp lý. Upstream
   * theo dõi tiến độ bằng chính số tin nhận được, không bằng lời hứa ở đây.
   */
  router.post('/:accountId/sync', async (req, res) => {
    const { accountId } = req.params;
    const session = requireLiveSession(res, accountId);
    if (!session) return;

    const { dialogLimit, messageLimit } = req.body ?? {};
    res.status(202).json({ accepted: true });

    syncHistory(cfg, session.client, accountId, { dialogLimit, messageLimit })
      .catch((err) => console.error(`[sync] account=${accountId} hỏng:`, errMsg(err)));
  });

  return router;
}
