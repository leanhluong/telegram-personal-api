import express from 'express';
import bigInt from 'big-integer';
import { Api } from 'telegram';
import { getSessionByAccountId, Status } from '../sessionStore.js';
import { describePeer, idToString } from '../peers.js';
import { errMsg } from '../errors.js';
import type { Config, ContactDescriptor, SessionRecord, TgClient, TgRaw } from '../types.js';

/**
 * Quản lý nhóm.
 *
 * <h3>Telegram có HAI loại nhóm, và mỗi loại một bộ lời gọi khác nhau</h3>
 *
 * <ul>
 *   <li><b>Nhóm thường</b> (<c>Chat</c>) — <c>messages.AddChatUser</c> · <c>messages.DeleteChatUser</c>
 *       · <c>messages.EditChatTitle</c></li>
 *   <li><b>Siêu nhóm / kênh</b> (<c>Channel</c>) — <c>channels.InviteToChannel</c> ·
 *       <c>channels.EditBanned</c> · <c>channels.EditTitle</c></li>
 * </ul>
 *
 * Gọi nhầm bộ thì Telegram trả lỗi kiểu <c>PEER_ID_INVALID</c> — thông báo chẳng liên quan gì tới
 * nguyên nhân thật, nên rất dễ đi sửa nhầm chỗ. Một nhóm thường TỰ ĐỘNG thành siêu nhóm khi vượt
 * ngưỡng thành viên hoặc bật vài tính năng, nghĩa là cùng một nhóm hôm nay chạy đường này, tháng
 * sau chạy đường kia. Vì vậy loại nhóm phải đọc từ ENTITY tại thời điểm gọi, không được nhớ.
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
  res.status(502).json({ error: msg });
}

async function resolveGroup(
  client: TgClient, groupId: string,
): Promise<{ entity: TgRaw; isChannel: boolean }> {
  const entity: TgRaw = await client.getEntity(bigInt(String(groupId)));
  const isChannel = entity?.className === 'Channel';
  return { entity, isChannel };
}

export function groupsRouter(cfg: Config): express.Router {
  const router = express.Router();

  /** GET /sessions/:accountId/groups/:groupId/members */
  router.get('/:accountId/groups/:groupId/members', async (req, res) => {
    const { accountId, groupId } = req.params;
    const session = requireLiveSession(res, accountId);
    if (!session) return;

    try {
      const { entity } = await resolveGroup(session.client, groupId);
      const participants: TgRaw = await session.client.getParticipants(entity, { limit: 200 });

      const members: ContactDescriptor[] = participants.map((u: TgRaw) => ({
        ...describePeer(cfg, accountId, u),
        userId: idToString(u.id),
        username: u.username ?? null,
        phone: u.phone ?? null,
        isBot: u.bot === true,
      }));

      console.log(`[group.members] account=${accountId} group=${groupId} n=${members.length}`);
      // `total` là con số Telegram báo; `members` có thể ít hơn vì trần 200 ở trên. Trả cả hai để
      // nơi gọi biết mình đang nhìn một phần — im lặng cắt bớt là cách hỏng tệ nhất.
      res.json({ members, total: participants.total ?? members.length });
    } catch (err) {
      fail(res, 'group.members', accountId, err);
    }
  });

  /**
   * POST /sessions/:accountId/groups/:groupId/members
   * body { userId }
   */
  router.post('/:accountId/groups/:groupId/members', async (req, res) => {
    const { accountId, groupId } = req.params;
    const { userId } = req.body ?? {};
    if (!userId) return res.status(400).json({ error: 'Cần userId' });

    const session = requireLiveSession(res, accountId);
    if (!session) return undefined;

    try {
      const { entity, isChannel } = await resolveGroup(session.client, groupId);
      const user = await session.client.getInputEntity(bigInt(String(userId)));

      if (isChannel) {
        await session.client.invoke(new Api.channels.InviteToChannel({ channel: entity, users: [user] }));
      } else {
        // fwdLimit = số tin cũ người mới được thấy. 0 là kín đáo nhất và cũng là mặc định an toàn:
        // thêm người vào nhóm rồi để họ đọc ngược lịch sử là chuyện không ai bấm nút để xin.
        await session.client.invoke(new Api.messages.AddChatUser({
          chatId: entity.id, userId: user, fwdLimit: 0,
        }));
      }

      console.log(`[group.add] account=${accountId} group=${groupId} user=${userId} channel=${isChannel}`);
      return res.json({ ok: true });
    } catch (err) {
      fail(res, 'group.add', accountId, err);
      return undefined;
    }
  });

  /** DELETE /sessions/:accountId/groups/:groupId/members/:userId */
  router.delete('/:accountId/groups/:groupId/members/:userId', async (req, res) => {
    const { accountId, groupId, userId } = req.params;
    const session = requireLiveSession(res, accountId);
    if (!session) return;

    try {
      const { entity, isChannel } = await resolveGroup(session.client, groupId);
      const user = await session.client.getInputEntity(bigInt(String(userId)));

      if (isChannel) {
        // kickParticipant của GramJS lo phần EditBanned + gỡ lệnh cấm sau đó, nên người bị xoá vẫn
        // quay lại được nếu được mời. Tự viết EditBanned dễ thành CẤM VĨNH VIỄN mà không ai định thế.
        await session.client.kickParticipant(entity, user);
      } else {
        await session.client.invoke(new Api.messages.DeleteChatUser({
          chatId: entity.id, userId: user, revokeHistory: false,
        }));
      }

      console.log(`[group.remove] account=${accountId} group=${groupId} user=${userId} channel=${isChannel}`);
      res.json({ ok: true });
    } catch (err) {
      fail(res, 'group.remove', accountId, err);
    }
  });

  /**
   * POST /sessions/:accountId/groups/:groupId/rename
   * body { title }
   */
  router.post('/:accountId/groups/:groupId/rename', async (req, res) => {
    const { accountId, groupId } = req.params;
    const { title } = req.body ?? {};
    if (!title || typeof title !== 'string') return res.status(400).json({ error: 'Cần title' });

    const session = requireLiveSession(res, accountId);
    if (!session) return undefined;

    try {
      const { entity, isChannel } = await resolveGroup(session.client, groupId);

      if (isChannel) {
        await session.client.invoke(new Api.channels.EditTitle({ channel: entity, title }));
      } else {
        await session.client.invoke(new Api.messages.EditChatTitle({ chatId: entity.id, title }));
      }

      console.log(`[group.rename] account=${accountId} group=${groupId} channel=${isChannel}`);
      return res.json({ ok: true, title });
    } catch (err) {
      fail(res, 'group.rename', accountId, err);
      return undefined;
    }
  });

  return router;
}
