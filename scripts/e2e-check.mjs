// Kiểm end-to-end: dựng upstream giả (đúng contract NextX Comm) + chạy service đã build,
// rồi đo hành vi thật qua HTTP. KHÔNG cần .NET, không cần tài khoản Telegram.
//
// Cái này kiểm được, và cái này KHÔNG:
//   ✔ service gọi đúng endpoint sessions của upstream, kèm đúng header X-System-Key
//   ✔ service đọc được DTO phiên của comm (externalId/displayName/sessionString)
//   ✔ sessionString hỏng thì thất bại GỌN, service không sập
//   ✔ mã trạng thái của từng route khi chưa có phiên
//   ✔ api_id/api_hash bắt buộc — thiếu là DỪNG NGAY lúc khởi động, không nổ muộn
//   ✘ luồng tin thật (cần người quét QR bằng app Telegram) — không giả được
//
// Chạy: node scripts/e2e-check.mjs

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SYSTEM_KEY = 'test-key';
const MOCK_PORT = 5098;
const SVC_PORT = 3298;
const BASE = `http://127.0.0.1:${SVC_PORT}`;

// api_id/api_hash giả: đủ để service khởi động, nhưng Telegram sẽ từ chối khi thật sự dùng.
// Đó chính là điều cần đo ở bước khôi phục — thất bại phải GỌN.
const FAKE_API_ID = '123456';
const FAKE_API_HASH = '0123456789abcdef0123456789abcdef';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Đúng shape TelegramPersonalSessionDto của comm. sessionString không phải chuỗi thật. */
const fakeSession = {
  externalId: '5320747093',
  displayName: 'Tài khoản kiểm thử',
  sessionString: 'khong-phai-chuoi-phien-that',
};

const mockLog = [];
const svcLog = [];
let mock, svc;

const sessionsFile = join(tmpdir(), `tg-e2e-sessions-${process.pid}.json`);
writeFileSync(sessionsFile, JSON.stringify([fakeSession]), 'utf8');

function startMock() {
  return new Promise((resolve) => {
    mock = spawn(process.execPath, ['scripts/mock-upstream.mjs', String(MOCK_PORT)], {
      env: { ...process.env, SYSTEM_KEY, MOCK_SESSIONS: sessionsFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    mock.stdout.on('data', (d) => {
      const s = d.toString();
      mockLog.push(s);
      if (s.includes('đang chạy ở')) resolve();
    });
    mock.stderr.on('data', (d) => mockLog.push(d.toString()));
  });
}

function svcEnv(extra = {}) {
  return {
    ...process.env,
    PORT: String(SVC_PORT),
    SYSTEM_KEY,
    TELEGRAM_API_ID: FAKE_API_ID,
    TELEGRAM_API_HASH: FAKE_API_HASH,
    UPSTREAM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    // Trỏ đúng đường của NextX Comm để chứng minh phần cấu hình hoạt động.
    UPSTREAM_WEBHOOK_PATH: '/api/v1/comm/webhook/telegram-personal',
    UPSTREAM_SESSIONS_PATH: '/api/v1/comm/channels/telegram-personal/internal/sessions',
    PUBLIC_BASE_URL: `http://127.0.0.1:${SVC_PORT}`,
    ...extra,
  };
}

function startService() {
  return new Promise((resolve) => {
    svc = spawn(process.execPath, ['dist/index.js'], {
      env: svcEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    svc.stdout.on('data', (d) => {
      const s = d.toString();
      svcLog.push(s);
      if (s.includes('nghe ở cổng')) resolve();
    });
    svc.stderr.on('data', (d) => svcLog.push(d.toString()));
  });
}

/** Chạy service với env thiếu và trả về { code, output } — dùng để đo nhánh fail-fast. */
function runExpectingExit(env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['dist/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code, output: out }));
    // Không thoát trong 8s nghĩa là nó KHÔNG fail-fast — cũng là một kết quả cần biết.
    setTimeout(() => { p.kill(); resolve({ code: null, output: out }); }, 8000).unref();
  });
}

async function req(method, path, body) {
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await resp.json();
  } catch { /* có route trả 204 rỗng */ }
  return { status: resp.status, json };
}

try {
  console.log('\n── api_id/api_hash bắt buộc ────────────────────────────────');
  const noCreds = { ...svcEnv() };
  delete noCreds.TELEGRAM_API_ID;
  const bail = await runExpectingExit(noCreds);
  check(
    'thiếu TELEGRAM_API_ID → DỪNG NGAY, không chạy tiếp',
    bail.code !== null && bail.code !== 0,
    bail.code === null ? 'không thoát trong 8s' : `exit=${bail.code}`,
  );
  check(
    'thông báo chỉ thẳng my.telegram.org, không nói chung chung',
    bail.output.includes('my.telegram.org'),
  );

  console.log('\n── Dựng upstream giả + service ─────────────────────────────');
  await startMock();
  await startService();

  // Đợi vòng khôi phục chạy xong theo ĐIỀU KIỆN, không theo mốc thời gian đoán.
  const restoreDone = await (async () => {
    for (let i = 0; i < 60; i++) {
      const t = svcLog.join('');
      if (t.includes('[restore] xong') || t.includes('không có phiên nào')) return true;
      await sleep(500);
    }
    return false;
  })();
  if (!restoreDone) console.log('  (cảnh báo: vòng khôi phục chưa kết thúc trong 30s)');

  console.log('\n── Contract với upstream ───────────────────────────────────');
  const mockText = mockLog.join('');
  const svcText = svcLog.join('');
  check(
    'service gọi ĐÚNG endpoint sessions của comm',
    mockText.includes('GET sessions'),
    mockText.includes('GET sessions') ? '' : 'mock không nhận được request nào',
  );
  check(
    'gửi kèm X-System-Key hợp lệ (không bị 401)',
    !mockText.includes('401 sessions'),
    mockText.includes('401 sessions') ? 'upstream từ chối — thiếu/sai key' : '',
  );
  check(
    'đọc được DTO phiên của comm (externalId + displayName)',
    mockText.includes('→ 1 phiên') && svcText.includes(fakeSession.displayName),
    svcText.includes(fakeSession.displayName) ? '' : 'service không parse được danh sách phiên',
  );
  const stillAlive = (await req('GET', '/health')).status === 200;
  check(
    'sessionString hỏng thì thất bại GỌN, service không sập',
    svcText.includes('[restore] xong') && stillAlive,
    svcText.includes('[restore] xong') ? '' : 'không thấy log kết thúc khôi phục',
  );
  check(
    'đếm CẢ hai chiều (restored + failed), không chỉ khoe số thành công',
    /"restored":\s*\d+.*"failed":\s*\d+/.test(svcText),
  );

  console.log('\n── Health ──────────────────────────────────────────────────');
  const health = await req('GET', '/health');
  check(
    'GET /health → 200 { ok, sessions, confirmed }',
    health.status === 200 && health.json?.ok === true
      && typeof health.json?.sessions === 'number'
      && typeof health.json?.confirmed === 'number',
    JSON.stringify(health.json),
  );

  console.log('\n── Mã trạng thái khi CHƯA có phiên ─────────────────────────');
  const cases = [
    ['GET /sessions (chẩn đoán)', 'GET', '/sessions', null, 200],
    ['GET /sessions/:token/status (token lạ)', 'GET', '/sessions/token-la/status', null, 404],
    ['POST /sessions/:token/password thiếu mật khẩu', 'POST', '/sessions/tok/password', {}, 400],
    ['POST /sessions/:token/password token lạ', 'POST', '/sessions/tok/password', { password: 'x' }, 404],
    ['GET /sessions/:id/health (không có phiên)', 'GET', '/sessions/khong-co/health', null, 200],
    ['POST send-text thiếu field', 'POST', '/sessions/x/send-text', { threadId: '1' }, 400],
    ['POST send-text không có phiên', 'POST', '/sessions/x/send-text', { threadId: '1', text: 'hi' }, 404],
    ['POST send-file thiếu fileUrl', 'POST', '/sessions/x/send-file', { threadId: '1' }, 400],
    ['POST typing không có phiên', 'POST', '/sessions/x/typing', { threadId: '1' }, 404],
    ['POST react thiếu msgId', 'POST', '/sessions/x/react', { threadId: '1' }, 400],
    ['POST unsend thiếu msgId', 'POST', '/sessions/x/unsend', { threadId: '1' }, 400],
    ['GET dialogs không có phiên', 'GET', '/sessions/x/dialogs', null, 404],
    ['POST sync không có phiên', 'POST', '/sessions/x/sync', {}, 404],
    ['GET /avatars không có phiên', 'GET', '/avatars/x/1', null, 503],
    ['GET /media không có phiên', 'GET', '/media/x/1/2', null, 503],
    ['DELETE /sessions/:id luôn 204', 'DELETE', '/sessions/khong-co', null, 204],
  ];
  for (const [name, method, path, body, want] of cases) {
    const r = await req(method, path, body);
    check(`${name} → ${want}`, r.status === want, r.status === want ? '' : `nhận ${r.status}`);
  }

  console.log('\n── /sessions/:id/health khi không có phiên ─────────────────');
  const h = await req('GET', '/sessions/khong-co/health');
  check(
    'trả healthy=false + reason=no_session',
    h.json?.healthy === false && h.json?.reason === 'no_session',
    JSON.stringify(h.json),
  );
} finally {
  svc?.kill();
  mock?.kill();
  await sleep(300);
  try { rmSync(sessionsFile, { force: true }); } catch { /* best-effort */ }
}

const failed = results.filter((r) => !r.ok);
console.log('\n────────────────────────────────────────────────────────────');
console.log(`KẾT QUẢ: ${results.length - failed.length}/${results.length} đạt`);
if (failed.length > 0) {
  console.log('\nKHÔNG ĐẠT:');
  for (const f of failed) console.log(`  ✘ ${f.name} ${f.detail}`);
  process.exit(1);
}
