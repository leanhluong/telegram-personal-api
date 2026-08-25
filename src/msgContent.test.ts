import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAttachments, extractText, toInboundPayload } from './msgContent.js';
import type { Config, TgRaw } from './types.js';

// Chỉ `publicBaseUrl` được dùng trong các hàm đang kiểm — ép kiểu thay vì dựng cả Config thật.
const cfg = { publicBaseUrl: 'http://telegram-personal-api:3200' } as unknown as Config;

const msg = (over: TgRaw = {}): TgRaw =>
  ({ id: 1, date: 1_700_000_000, out: false, message: '', ...over });

// ── Khoá khử trùng ───────────────────────────────────────────────────────

test('khoá khử trùng ghép hội thoại với id tin', () => {
  const p = toInboundPayload(cfg, { msg: msg({ id: 42 }), accountId: 'A', threadId: '777', peerKind: 'user' });
  assert.equal(p.dedupKey, '777:42');
});

test('hai người lạ cùng tin đầu tiên KHÔNG được trùng khoá', () => {
  // id của Telegram chỉ duy nhất trong một hội thoại: hai người khác nhau cùng nhắn tin đầu tiên
  // thì cả hai đều là id=1. Khử trùng bằng riêng id là nuốt mất tin thứ hai, không lỗi, không log.
  const a = toInboundPayload(cfg, { msg: msg({ id: 1 }), accountId: 'A', threadId: '111', peerKind: 'user' });
  const b = toInboundPayload(cfg, { msg: msg({ id: 1 }), accountId: 'A', threadId: '222', peerKind: 'user' });
  assert.equal(a.msgId, b.msgId, 'tiền đề: cùng msgId');
  assert.notEqual(a.dedupKey, b.dedupKey);
});

// ── Người viết vs hội thoại ──────────────────────────────────────────────

test('trong nhóm, người viết KHÁC hội thoại', () => {
  // Lấy nhầm thì mọi tin trong nhóm gộp về một liên hệ mang tên nhóm, và câu trả lời đi vào nhóm —
  // hiện ra với tất cả thành viên.
  const p = toInboundPayload(cfg, {
    msg: msg({ fromId: { userId: '555' } }),
    accountId: 'A', threadId: '999', peerKind: 'group',
  });
  assert.equal(p.threadId, '999');
  assert.equal(p.senderId, '555');
});

test('chat riêng không có fromId thì người viết chính là hội thoại', () => {
  const p = toInboundPayload(cfg, { msg: msg(), accountId: 'A', threadId: '333', peerKind: 'user' });
  assert.equal(p.senderId, '333');
});

// ── Chiều tin ────────────────────────────────────────────────────────────

test('tin chính chủ gửi từ điện thoại là chiều Out', () => {
  // Bỏ chiều này thì nhân viên trả lời bằng app Telegram xong, hộp thư vẫn hiện "chưa ai trả lời"
  // và SLA đếm sai.
  const p = toInboundPayload(cfg, { msg: msg({ out: true }), accountId: 'A', threadId: '1', peerKind: 'user' });
  assert.equal(p.direction, 'Out');
});

test('mặc định là chiều In', () => {
  const p = toInboundPayload(cfg, { msg: msg(), accountId: 'A', threadId: '1', peerKind: 'user' });
  assert.equal(p.direction, 'In');
});

// ── Mốc thời gian ────────────────────────────────────────────────────────

test('đổi giây của Telegram sang mili giây', () => {
  // Quên nhân 1000 thì mọi tin rơi về tháng 1/1970 và thứ tự hộp thư loạn hết.
  const p = toInboundPayload(cfg, { msg: msg({ date: 1_700_000_000 }), accountId: 'A', threadId: '1', peerKind: 'user' });
  assert.equal(p.timestamp, 1_700_000_000_000);
});

// ── Tệp đính kèm ─────────────────────────────────────────────────────────

test('ảnh sinh đúng đường tải do service tự phục vụ', () => {
  const [a] = extractAttachments(cfg, msg({ id: 7, media: { className: 'MessageMediaPhoto' } }), 'A', '99');
  assert.equal(a!.type, 'image');
  assert.equal(a!.url, 'http://telegram-personal-api:3200/media/A/99/7');
});

test('tin thoại nhận ra là audio chứ không phải file', () => {
  const media = {
    className: 'MessageMediaDocument',
    document: { mimeType: 'audio/ogg', size: 1024, attributes: [{ className: 'DocumentAttributeAudio', voice: true }] },
  };
  const [a] = extractAttachments(cfg, msg({ media }), 'A', '99');
  assert.equal(a!.type, 'audio');
});

test('bản xem trước liên kết KHÔNG phải tệp đính kèm', () => {
  // Coi nó là đính kèm thì mỗi tin có link lại đẻ thêm một "tệp" giả trong hộp thư.
  const out = extractAttachments(cfg, msg({ media: { className: 'MessageMediaWebPage' } }), 'A', '99');
  assert.deepEqual(out, []);
});

test('loại chưa biết vẫn giữ lại kèm tên thật, không nuốt', () => {
  // Bỏ qua im lặng thì tin hiện ra rỗng và mất luôn cơ hội đọc ra hình dạng thật.
  const [a] = extractAttachments(cfg, msg({ media: { className: 'MessageMediaPoll' } }), 'A', '99');
  assert.equal(a!.type, 'unknown');
  assert.equal(a!.className, 'MessageMediaPoll');
});

test('tin không có media thì không có đính kèm', () => {
  assert.deepEqual(extractAttachments(cfg, msg(), 'A', '99'), []);
});

// ── Văn bản ──────────────────────────────────────────────────────────────

test('tin chỉ có ảnh trả văn bản rỗng, không phải null', () => {
  assert.equal(extractText(msg({ media: { className: 'MessageMediaPhoto' } })), '');
});

test('giữ nguyên nội dung chữ', () => {
  assert.equal(extractText(msg({ message: 'chào anh' })), 'chào anh');
});
