import express from 'express';
import { Api } from 'telegram';
import { getSessionByAccountId, Status } from '../sessionStore.js';
import { describePeer, idToString } from '../peers.js';
import { errMsg } from '../errors.js';
import type { Config, ContactDescriptor, SessionRecord, TgClient, TgRaw } from '../types.js';

/**
 * Danh bạ và mở hội thoại mới.
 *
 * <h3>"Kết bạn" của Telegram không giống Zalo</h3>
 *
 * Zalo có lời mời kết bạn phải chờ đối phương bấm đồng ý. Telegram thì <b>không có lời mời</b>:
 * thêm một người vào danh bạ là việc đơn phương, và nhắn được cho người lạ ngay cả khi không thêm —
 * miễn là biết username hoặc họ chưa chặn tin từ người lạ. Vì vậy ở đây có
 * <c>POST /contacts</c> (thêm vào danh bạ) chứ KHÔNG có <c>accept</c>: dựng một đường "chấp nhận
 * lời mời" cho Telegram là dựng mã chết mô phỏng một khái niệm không tồn tại.
 *
 * <h3>Số điện thoại có thể im lặng không ra ai cả</h3>
 *
 * <c>contacts.ImportContacts</c> trả về danh sách <c>users</c> RỖNG khi số đó không có tài khoản
 * Telegram, hoặc chủ tài khoản đã chặn việc bị tìm bằng số. Không phải lỗi — nên phải nói rõ ra
 * thay vì trả 200 kèm một danh bạ trống mà người dùng tưởng đã thêm xong.
 */

type LiveSession = SessionRecord & { client: TgClient };

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

function fail(res: express.Response, what: string, accountId: string, err: unknown): void {
  const msg = errMsg(err);
  console.error(`[${what}] account=${accountId} lỗi: ${msg}`);
  // 502 = phía Telegram từ chối, không phải service hỏng. Upstream phân biệt được để quyết định
  // có thử lại hay không.
  res.status(502).json({ error: msg });
}

/** Một người trong danh bạ, đã quy về hình dạng upstream dùng. */
function toContact(cfg: Config, accountId: string, user: TgRaw): ContactDescriptor {
  return {
    ...describePeer(cfg, accountId, user),
    userId: idToString(user.id),
    username: user.username ?? null,
    phone: user.phone ?? null,
    isBot: user.bot === true,
  };
}

export function contactsRouter(cfg: Config): express.Router {
  const router = express.Router();

  /** GET /sessions/:accountId/contacts — toàn bộ danh bạ. */
  router.get('/:accountId/contacts', async (req, res) => {
    const { accountId } = req.params;
    const session = requireLiveSession(res, accountId);
    if (!session) return;

    try {
      // hash=0 nghĩa là "tôi chưa có gì, gửi hết". Telegram dùng hash để trả 304 khi danh bạ không
      // đổi; service không giữ cache giữa các lời gọi nên luôn xin bản đầy đủ.
      const result: TgRaw = await session.client.invoke(new Api.contacts.GetContacts({ hash: bigZero() }));
      const users: TgRaw[] = result?.users ?? [];
      console.log(`[contacts] account=${accountId} n=${users.length}`);
      res.json({ contacts: users.map((u) => toContact(cfg, accountId, u)) });
    } catch (err) {
      fail(res, 'contacts', accountId, err);
    }
  });

  /**
   * POST /sessions/:accountId/contacts
   * body { phone?, username?, firstName?, lastName? }  — cần phone HOẶC username
   */
  router.post('/:accountId/contacts', async (req, res) => {
    const { accountId } = req.params;
    const { phone, username, firstName, lastName } = req.body ?? {};

    if (!phone && !username) {
      return res.status(400).json({ error: 'Cần phone hoặc username' });
    }

    const session = requireLiveSession(res, accountId);
    if (!session) return undefined;

    try {
      if (username) {
        // Đường username: tra ra người trước rồi mới thêm — AddContact cần input user thật, không
        // nhận chuỗi username.
        const resolved: TgRaw = await session.client.invoke(
          new Api.contacts.ResolveUsername({ username: String(username).replace(/^@/, '') }));
        const user: TgRaw = resolved?.users?.[0];
        if (!user) return res.status(404).json({ error: `Không tìm thấy @${username}` });

        await session.client.invoke(new Api.contacts.AddContact({
          id: await session.client.getInputEntity(user),
          firstName: firstName ?? user.firstName ?? '',
          lastName: lastName ?? user.lastName ?? '',
          phone: '',
          addPhonePrivacyException: false,
        }));

        console.log(`[contacts.add] account=${accountId} username=${username} ok`);
        return res.json({ contact: toContact(cfg, accountId, user) });
      }

      const imported: TgRaw = await session.client.invoke(new Api.contacts.ImportContacts({
        contacts: [new Api.InputPhoneContact({
          clientId: bigFrom(Date.now()),
          phone: String(phone),
          firstName: firstName ?? String(phone),
          lastName: lastName ?? '',
        })],
      }));

      const user: TgRaw = imported?.users?.[0];
      if (!user) {
        // Danh sách rỗng KHÔNG phải lỗi kỹ thuật — nói rõ lý do thay vì trả 200 kèm danh bạ trống.
        return res.status(404).json({
          error: 'Số này chưa có tài khoản Telegram, hoặc chủ tài khoản không cho tìm bằng số điện thoại',
        });
      }

      console.log(`[contacts.add] account=${accountId} phone=***${String(phone).slice(-3)} ok`);
      return res.json({ contact: toContact(cfg, accountId, user) });
    } catch (err) {
      fail(res, 'contacts.add', accountId, err);
      return undefined;
    }
  });

  /**
   * POST /sessions/:accountId/resolve
   * body { username?, phone?, userId? }
   *
   * Tra ra một người để MỞ hội thoại mới. Khác <c>/contacts</c> ở chỗ KHÔNG thêm vào danh bạ:
   * Telegram cho nhắn người lạ, nên bắt thêm danh bạ trước là ép người dùng làm một việc thừa và
   * để lại dấu vết trong danh bạ của họ.
   */
  router.post('/:accountId/resolve', async (req, res) => {
    const { accountId } = req.params;
    const { username, phone, userId } = req.body ?? {};

    if (!username && !phone && !userId) {
      return res.status(400).json({ error: 'Cần username, phone hoặc userId' });
    }

    const session = requireLiveSession(res, accountId);
    if (!session) return undefined;

    try {
      let user: TgRaw = null;

      if (username) {
        const resolved: TgRaw = await session.client.invoke(
          new Api.contacts.ResolveUsername({ username: String(username).replace(/^@/, '') }));
        user = resolved?.users?.[0] ?? null;
      } else if (userId) {
        // Chỉ ra được nếu phiên đã từng thấy người này (cần access hash) — không thì báo rõ.
        user = await session.client.getEntity(bigFrom(String(userId))).catch(() => null);
      } else {
        const imported: TgRaw = await session.client.invoke(new Api.contacts.ImportContacts({
          contacts: [new Api.InputPhoneContact({
            clientId: bigFrom(Date.now()), phone: String(phone), firstName: String(phone), lastName: '',
          })],
        }));
        user = imported?.users?.[0] ?? null;
      }

      if (!user) {
        return res.status(404).json({
          error: 'Không tra được người dùng — có thể chưa có tài khoản Telegram, hoặc họ giới hạn tìm kiếm',
        });
      }

      return res.json({ contact: toContact(cfg, accountId, user) });
    } catch (err) {
      fail(res, 'resolve', accountId, err);
      return undefined;
    }
  });

  return router;
}

// GramJS khai các trường này là `BigInteger` của thư viện `big-integer`, nhưng runtime nhận cả
// bigint gốc. Bọc lại một chỗ thay vì rải `as any` khắp nơi.
function bigFrom(v: number | string): TgRaw {
  return BigInt(v) as TgRaw;
}
function bigZero(): TgRaw {
  return BigInt(0) as TgRaw;
}
