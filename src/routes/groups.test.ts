import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSession, updateSession, Status, _clear } from '../sessionStore.js';
import { groupsRouter } from './groups.js';
import { contactsRouter } from './contacts.js';
import type { AddressInfo } from 'node:net';
import type { Config, TgClient, TgRaw } from '../types.js';

/**
 * Nhóm thường và siêu nhóm dùng HAI bộ lời gọi khác nhau, và gọi nhầm bộ thì Telegram trả
 * <c>PEER_ID_INVALID</c> — thông báo không liên quan gì tới nguyên nhân thật. Một nhóm thường còn
 * TỰ ĐỘNG thành siêu nhóm khi đông lên, nên cùng một nhóm hôm nay đi đường này, tháng sau đường
 * kia. Test khoá đúng chỗ đó: cùng một request, entity khác loại → lời gọi khác.
 */

const ACCOUNT = '5320747093';
const GROUP = '987654321';
const USER = '111222333';

type Call = [string, ...TgRaw[]];

interface FakeClient {
  calls: Call[];
  getEntity: (id: TgRaw) => Promise<TgRaw>;
  getInputEntity: (id: TgRaw) => Promise<TgRaw>;
  getParticipants: () => Promise<TgRaw>;
  kickParticipant: (entity: TgRaw, user: TgRaw) => Promise<void>;
  invoke: (request: TgRaw) => Promise<TgRaw>;
}

function fakeClient(entityClassName: string): FakeClient {
  const calls: Call[] = [];
  return {
    calls,
    getEntity: async (id: TgRaw) => ({ id, className: entityClassName }),
    getInputEntity: async (id: TgRaw) => ({ id, className: 'InputUser' }),
    getParticipants: async () => Object.assign(
      [{ id: 1, firstName: 'Ninh', username: 'ninh', bot: false }], { total: 42 }),
    kickParticipant: async (entity: TgRaw, user: TgRaw) => { calls.push(['kickParticipant', entity, user]); },
    invoke: async (request: TgRaw) => {
      calls.push(['invoke', request]);
      return { users: [] };
    },
  };
}

const fakeCfg = { publicBaseUrl: 'http://service' } as unknown as Config;

const portOf = (s: { address: () => AddressInfo | string | null }): number =>
  (s.address() as AddressInfo).port;

function startServer(entityClassName: string) {
  _clear();
  const client = fakeClient(entityClassName);
  createSession('k1', { client: client as unknown as TgClient });
  updateSession('k1', { accountId: ACCOUNT, status: Status.Confirmed });

  const app = express();
  app.use(express.json());
  app.use('/sessions', groupsRouter(fakeCfg));
  app.use('/sessions', contactsRouter(fakeCfg));
  const server = app.listen(0);
  return { client, server, base: `http://127.0.0.1:${portOf(server)}/sessions/${ACCOUNT}` };
}

async function send(base: string, method: string, path: string, body?: unknown) {
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await resp.json().catch(() => null)) as TgRaw;
  return { status: resp.status, json };
}

/** Lấy tham số của lời gọi `invoke` đầu tiên — test tự dựng nên vắng nghĩa là test sai. */
function firstInvoke(client: FakeClient): TgRaw {
  const call = client.calls.find((c) => c[0] === 'invoke');
  assert.ok(call, 'phải có lời gọi invoke');
  return call[1];
}

test('thêm thành viên: siêu nhóm dùng InviteToChannel', async (t) => {
  const { client, server, base } = startServer('Channel');
  t.after(() => server.close());

  const res = await send(base, 'POST', `/groups/${GROUP}/members`, { userId: USER });

  assert.equal(res.status, 200);
  assert.equal(firstInvoke(client).className, 'channels.InviteToChannel');
});

test('thêm thành viên: nhóm thường dùng AddChatUser, không cho đọc ngược lịch sử', async (t) => {
  const { client, server, base } = startServer('Chat');
  t.after(() => server.close());

  await send(base, 'POST', `/groups/${GROUP}/members`, { userId: USER });

  const req = firstInvoke(client);
  assert.equal(req.className, 'messages.AddChatUser');
  assert.equal(Number(req.fwdLimit), 0,
    'fwdLimit > 0 cho người mới đọc tin cũ — chuyện không ai bấm nút để xin');
});

test('xoá thành viên: siêu nhóm đi kickParticipant, KHÔNG tự viết EditBanned', async (t) => {
  const { client, server, base } = startServer('Channel');
  t.after(() => server.close());

  await send(base, 'DELETE', `/groups/${GROUP}/members/${USER}`);

  assert.ok(client.calls.some((c) => c[0] === 'kickParticipant'),
    'tự viết EditBanned dễ thành cấm vĩnh viễn mà không ai định thế');
});

test('xoá thành viên: nhóm thường dùng DeleteChatUser', async (t) => {
  const { client, server, base } = startServer('Chat');
  t.after(() => server.close());

  await send(base, 'DELETE', `/groups/${GROUP}/members/${USER}`);

  assert.equal(firstInvoke(client).className, 'messages.DeleteChatUser');
});

test('đổi tên: hai loại nhóm hai lời gọi', async (t) => {
  const chan = startServer('Channel');
  t.after(() => chan.server.close());
  await send(chan.base, 'POST', `/groups/${GROUP}/rename`, { title: 'Nhóm CSKH' });
  assert.equal(firstInvoke(chan.client).className, 'channels.EditTitle');

  const chat = startServer('Chat');
  t.after(() => chat.server.close());
  await send(chat.base, 'POST', `/groups/${GROUP}/rename`, { title: 'Nhóm CSKH' });
  assert.equal(firstInvoke(chat.client).className, 'messages.EditChatTitle');
});

test('danh sách thành viên trả cả total để nơi gọi biết mình đang xem một phần', async (t) => {
  const { server, base } = startServer('Channel');
  t.after(() => server.close());

  const res = await send(base, 'GET', `/groups/${GROUP}/members`);

  assert.equal(res.status, 200);
  assert.equal(res.json.members.length, 1);
  assert.equal(res.json.total, 42, 'im lặng cắt bớt danh sách là cách hỏng tệ nhất');
});

test('thêm danh bạ bằng số lạ: nói rõ lý do thay vì trả danh bạ trống', async (t) => {
  const { server, base } = startServer('Chat');
  t.after(() => server.close());

  // invoke của client giả trả { users: [] } — đúng thứ Telegram trả khi số không có tài khoản.
  const res = await send(base, 'POST', '/contacts', { phone: '84900000000' });

  assert.equal(res.status, 404);
  assert.match(res.json.error, /Telegram|số điện thoại/i);
});
