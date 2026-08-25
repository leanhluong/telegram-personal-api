import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, updateSession, getSession, getSessionByAccountId,
  adoptSession, deleteSession, touchSession, listSessions, Status, _clear,
} from './sessionStore.js';

import type { SessionRecord, TgClient } from './types.js';

interface FakeClient {
  disconnected: number;
  disconnect: () => Promise<void>;
}

/** Client giả — chỉ cần đếm số lần bị ngắt, nên ép kiểu thay vì dựng cả TelegramClient thật. */
function fakeClient(): FakeClient {
  const c: FakeClient = {
    disconnected: 0,
    disconnect: async () => { c.disconnected++; },
  };
  return c;
}

/** Lấy phiên và khẳng định nó tồn tại — test tự dựng nên null nghĩa là test sai. */
function must(s: SessionRecord | null): SessionRecord {
  assert.ok(s, 'phiên phải tồn tại');
  return s;
}

function put(key: string, accountId: string, { createdAt }: { createdAt?: number } = {}): FakeClient {
  const client = fakeClient();
  createSession(key, { client: client as unknown as TgClient });
  updateSession(key, { accountId, status: Status.Confirmed, ...(createdAt ? { createdAt } : {}) });
  return client;
}

test.beforeEach(() => _clear());

test('tra theo accountId trả phiên MỚI NHẤT', async () => {
  // Trả phiên cũ = tin đến vẫn chạy qua phiên mới, còn tin gửi đi chết ở phiên cũ đã bị thu hồi.
  // Inbound sống, outbound chết, và không có lỗi nào nói ra điều đó.
  put('cu', 'acc1', { createdAt: 1000 });
  put('moi', 'acc1', { createdAt: 2000 });

  assert.equal(must(getSessionByAccountId('acc1')).createdAt, 2000);
});

test('adoptSession ngắt và xoá mọi phiên cũ cùng tài khoản', async () => {
  // Không dọn thì mỗi phiên cũ vẫn đang nghe và đẩy CÙNG một tin về upstream thêm một lần nữa.
  const cu = put('cu', 'acc1', { createdAt: 1000 });
  put('moi', 'acc1', { createdAt: 2000 });

  const dropped = await adoptSession('moi', 'acc1');

  assert.equal(dropped, 1);
  assert.equal(cu.disconnected, 1, 'phiên cũ phải bị ngắt, không chỉ xoá khỏi Map');
  assert.equal(getSession('cu'), null);
  assert.ok(getSession('moi'));
});

test('adoptSession không đụng tài khoản khác', async () => {
  put('khac', 'acc2');
  put('cua-toi', 'acc1');

  await adoptSession('cua-toi', 'acc1');

  assert.ok(getSession('khac'), 'phiên của tài khoản khác phải còn nguyên');
});

test('deleteSession xoá HẾT entry của tài khoản, không chỉ cái đầu', async () => {
  const a = put('a', 'acc1', { createdAt: 1000 });
  const b = put('b', 'acc1', { createdAt: 2000 });

  const removed = await deleteSession('acc1');

  assert.equal(removed, 2);
  assert.equal(a.disconnected, 1);
  assert.equal(b.disconnected, 1);
  assert.equal(getSessionByAccountId('acc1'), null);
});

test('client ném khi ngắt cũng không làm hỏng việc dọn', async () => {
  createSession('xau', { client: { disconnect: async () => { throw new Error('bùm'); } } as unknown as TgClient });
  updateSession('xau', { accountId: 'acc1' });

  await assert.doesNotReject(() => deleteSession('acc1'));
  assert.equal(getSession('xau'), null);
});

test('touchSession đóng dấu lên phiên mới nhất', () => {
  put('cu', 'acc1', { createdAt: 1000 });
  put('moi', 'acc1', { createdAt: 2000 });

  assert.equal(touchSession('acc1'), true);

  assert.equal(must(getSession('cu')).lastEventAt, null, 'phiên cũ không được đóng dấu');
  assert.ok((must(getSession('moi')).lastEventAt ?? 0) > 0);
  assert.equal(must(getSession('moi')).connected, true);
});

test('touchSession cho tài khoản không có phiên trả false, không ném', () => {
  assert.equal(touchSession('khong-ton-tai'), false);
});

test('phiên mới sinh ra ở trạng thái chờ', () => {
  createSession('k', { client: fakeClient() as unknown as TgClient });
  assert.equal(must(getSession('k')).status, Status.Waiting);
  assert.equal(must(getSession('k')).sessionString, null);
});

test('listSessions trả về tóm tắt', () => {
  put('a', 'acc1');
  assert.deepEqual(listSessions(), [
    { accountId: 'acc1', status: Status.Confirmed, displayName: null, connected: false },
  ]);
});
