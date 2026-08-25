import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSession, updateSession, Status, _clear } from '../sessionStore.js';
import { messagesRouter } from './messages.js';

/**
 * Bốn đường mới (gửi tệp · đang gõ · cảm xúc · thu hồi) chạy thật qua HTTP với một client giả.
 *
 * Vì sao không kiểm ở mức "có gọi hàm không" mà bắt THAM SỐ gửi xuống MTProto: ba trong bốn lỗi
 * đáng sợ ở đây đều là lỗi im lặng — quên `revoke` thì tin chỉ biến mất phía mình, quên
 * `forceDocument` thì ảnh hiện thành tệp phải bấm tải, gỡ cảm xúc mà gửi kèm emoji thì thành
 * THẢ chứ không phải gỡ. Cả ba đều trả 200 và log "thành công".
 */

const ACCOUNT = '5320747093';
const THREAD = '123456789';

import type { AddressInfo } from 'node:net';
import type { Config, TgClient, TgRaw } from '../types.js';

/** Một lời gọi đã ghi lại: [tên method, ...tham số]. */
type Call = [string, ...TgRaw[]];

interface FakeClient {
  calls: Call[];
  getEntity: (id: TgRaw) => Promise<TgRaw>;
  getDialogs: () => Promise<TgRaw[]>;
  sendMessage: (entity: TgRaw, opts: TgRaw) => Promise<TgRaw>;
  sendFile: (entity: TgRaw, opts: TgRaw) => Promise<TgRaw>;
  deleteMessages: (entity: TgRaw, ids: TgRaw, opts: TgRaw) => Promise<boolean>;
  markAsRead: (entity: TgRaw) => Promise<boolean>;
  invoke: (request: TgRaw) => Promise<boolean>;
}

/** Client giả: ghi lại mọi lời gọi để test soi, và trả về hình dạng tối thiểu route cần. */
function fakeClient(): FakeClient {
  const calls: Call[] = [];
  return {
    calls,
    getEntity: async (id: TgRaw) => ({ id, className: 'User' }),
    getDialogs: async () => [],
    sendMessage: async (entity: TgRaw, opts: TgRaw) => {
      calls.push(['sendMessage', entity, opts]);
      return { id: 11 };
    },
    sendFile: async (entity: TgRaw, opts: TgRaw) => {
      calls.push(['sendFile', entity, opts]);
      return { id: 22 };
    },
    deleteMessages: async (entity: TgRaw, ids: TgRaw, opts: TgRaw) => {
      calls.push(['deleteMessages', entity, ids, opts]);
      return true;
    },
    markAsRead: async (entity: TgRaw) => {
      calls.push(['markAsRead', entity]);
      return true;
    },
    invoke: async (request: TgRaw) => {
      calls.push(['invoke', request]);
      return true;
    },
  };
}

/** Route chỉ dùng session store, không đọc cfg — ép kiểu thay vì dựng Config thật. */
const fakeCfg = {} as unknown as Config;

const portOf = (s: { address: () => AddressInfo | string | null }): number =>
  (s.address() as AddressInfo).port;

function startServer() {
  _clear();
  const client = fakeClient();
  createSession('k1', { client: client as unknown as TgClient });
  updateSession('k1', { accountId: ACCOUNT, status: Status.Confirmed });

  const app = express();
  app.use(express.json());
  app.use('/sessions', messagesRouter(fakeCfg));
  const server = app.listen(0);
  return { client, server, base: `http://127.0.0.1:${portOf(server)}/sessions/${ACCOUNT}` };
}

async function post(base: string, path: string, body: unknown) {
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await resp.json().catch(() => null)) as { error?: string } | null;
  return { status: resp.status, json };
}

test('unsend thu hồi ở CẢ HAI phía (revoke)', async (t) => {
  const { client, server, base } = startServer();
  t.after(() => server.close());

  const res = await post(base, '/unsend', { threadId: THREAD, msgId: '77' });

  assert.equal(res.status, 200);
  const call = client.calls.find((c) => c[0] === 'deleteMessages');
  assert.ok(call, 'phải gọi deleteMessages');
  if (!call) return;
  assert.deepEqual(call[2], [77], 'id tin phải là SỐ — chuỗi thì MTProto bỏ qua');
  assert.equal(call[3].revoke, true,
    'thiếu revoke thì tin chỉ mất phía mình, khách vẫn đọc được — đúng thứ người bấm thu hồi tưởng đã tránh');
});

test('react gửi emoji; bỏ emoji nghĩa là GỠ', async (t) => {
  const { client, server, base } = startServer();
  t.after(() => server.close());

  await post(base, '/react', { threadId: THREAD, msgId: '77', emoji: '❤' });
  await post(base, '/react', { threadId: THREAD, msgId: '77' });

  const invokes = client.calls.filter((c) => c[0] === 'invoke').map((c) => c[1]);
  assert.equal(invokes.length, 2);
  assert.equal(invokes[0].reaction.length, 1, 'thả cảm xúc phải kèm đúng một emoji');
  assert.equal(invokes[0].reaction[0].emoticon, '❤');
  assert.equal(invokes[1].reaction.length, 0,
    'gỡ = danh sách RỖNG; gửi kèm emoji là thả lại chứ không phải gỡ');
});

test('typing gọi SetTyping với hành động đang-gõ', async (t) => {
  const { client, server, base } = startServer();
  t.after(() => server.close());

  const res = await post(base, '/typing', { threadId: THREAD });

  assert.equal(res.status, 200);
  const invoke = client.calls.find((c) => c[0] === 'invoke');
  assert.ok(invoke, 'phải gọi invoke');
  const req = invoke[1];
  assert.equal(req.className, 'messages.SetTyping');
  assert.equal(req.action.className, 'SendMessageTypingAction');
});

test('send-file: ảnh hiện trong khung chat, tệp thì buộc đính kèm', async (t) => {
  const { client, server, base } = startServer();
  t.after(() => server.close());

  // Máy chủ tệp giả — đứng thay kho tệp của upstream, và cũng chứng minh route thật sự TẢI VỀ
  // trước khi tải lên.
  const fileApp = express();
  fileApp.get('/anh.jpg', (_req, res) => res.type('image/jpeg').send(Buffer.from('0123456789')));
  const fileServer = fileApp.listen(0);
  t.after(() => fileServer.close());
  const fileUrl = `http://127.0.0.1:${portOf(fileServer)}/anh.jpg`;

  await post(base, '/send-file', {
    threadId: THREAD, fileUrl, fileName: 'anh.jpg', kind: 'image',
  });
  await post(base, '/send-file', {
    threadId: THREAD, fileUrl, fileName: 'bang-gia.pdf', kind: 'file',
  });

  const sends = client.calls.filter((c) => c[0] === 'sendFile').map((c) => c[2]);
  assert.equal(sends.length, 2);
  assert.equal(sends[0].forceDocument, false, 'ảnh phải hiện trong khung chat');
  assert.equal(sends[0].file.name, 'anh.jpg');
  assert.equal(sends[0].file.size, 10, 'kích thước phải là số byte THẬT đã tải về');
  assert.equal(sends[1].forceDocument, true, 'tệp thường thì buộc thành đính kèm');
});

test('send-file: liên kết hết hạn báo lỗi kho, không đổ cho Telegram', async (t) => {
  const { server, base } = startServer();
  t.after(() => server.close());

  const fileApp = express();
  fileApp.get('/het-han', (_req, res) => res.status(403).send('expired'));
  const fileServer = fileApp.listen(0);
  t.after(() => fileServer.close());

  const res = await post(base, '/send-file', {
    threadId: THREAD,
    fileUrl: `http://127.0.0.1:${portOf(fileServer)}/het-han`,
    fileName: 'x.pdf',
  });

  assert.equal(res.status, 502);
  assert.match(String(res.json?.error), /kho|hết hạn/i,
    'phải nói rõ hỏng ở bước lấy tệp, nếu không người đọc log đi tìm nhầm phía Telegram');
});

test('phiên chưa sẵn sàng thì từ chối, không im lặng nuốt', async (t) => {
  _clear();
  const app = express();
  app.use(express.json());
  app.use('/sessions', messagesRouter(fakeCfg));
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${portOf(server)}/sessions/khong-ton-tai`;

  const res = await post(base, '/typing', { threadId: THREAD });
  assert.equal(res.status, 404);
});
