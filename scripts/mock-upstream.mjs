// Upstream giả — dựng đúng contract mà NextX Comm expose, để chạy thử service này
// end-to-end mà không cần .NET, Postgres, RabbitMQ hay tài khoản Telegram thật.
//
// Contract lấy từ mã nguồn comm (đọc `origin/develop` ngày 25/08/2026):
//   - TelegramPersonalWebhookController.cs   → ĐÚNG MỘT [HttpPost] ở route gốc
//   - TelegramPersonalController.cs          → GET internal/sessions
//   - TelegramPersonalDtos.cs                → TelegramPersonalSessionDto
//        (ExternalId, DisplayName, SessionString)
//
// Khác Zalo: Telegram chỉ có MỘT đường webhook, không có /reaction, /typing… — sự kiện
// đi cùng một đường. Mock phản ánh đúng chừng đó, không bịa thêm đường không tồn tại.
//
// Xác thực: comm fail-closed bằng X-System-Key — thiếu/sai key trả 401. Mock làm đúng như vậy,
// đó chính là thứ cần kiểm: service có gửi kèm key không.
//
// Chạy:  node scripts/mock-upstream.mjs [port]
// Env:   SYSTEM_KEY (mặc định 'test-key'), MOCK_SESSIONS=path/to/sessions.json

import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 5000);
const SYSTEM_KEY = process.env.SYSTEM_KEY ?? 'test-key';

// Đường comm thật dùng; service trỏ vào bằng UPSTREAM_WEBHOOK_PATH / UPSTREAM_SESSIONS_PATH.
const WEBHOOK_PATH = '/api/v1/comm/webhook/telegram-personal';
const SESSIONS_PATH = '/api/v1/comm/channels/telegram-personal/internal/sessions';

/** Phiên trả cho service khôi phục. Mặc định rỗng — không có sessionString thật để dựng. */
const sessions = process.env.MOCK_SESSIONS
  ? JSON.parse(readFileSync(process.env.MOCK_SESSIONS, 'utf8'))
  : [];

function authOk(req) {
  return req.headers['x-system-key'] === SYSTEM_KEY;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // ── GET sessions để khôi phục ─────────────────────────────────────────────
  if (req.method === 'GET' && path === SESSIONS_PATH) {
    if (!authOk(req)) {
      console.log('[mock] 401 sessions — thiếu/sai X-System-Key');
      res.writeHead(401).end();
      return;
    }
    console.log(`[mock] GET sessions → ${sessions.length} phiên`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }

  // ── Webhook inbound (một đường duy nhất) ──────────────────────────────────
  if (req.method === 'POST' && path === WEBHOOK_PATH) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (!authOk(req)) {
        console.log(`[mock] 401 ${path} — thiếu/sai X-System-Key`);
        res.writeHead(401).end();
        return;
      }
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        console.log('[mock] inbound — body KHÔNG phải JSON hợp lệ');
      }
      // comm trả 200 ngay rồi xử lý async — mock làm giống để đo đúng hành vi service.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      console.log(`[mock] inbound ← dedupKey=${parsed?.dedupKey} direction=${parsed?.direction}`);
    });
    return;
  }

  console.log(`[mock] 404 ${req.method} ${path}`);
  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`[mock] upstream giả đang chạy ở :${PORT}`);
  console.log(`[mock]   webhook  ${WEBHOOK_PATH}`);
  console.log(`[mock]   sessions ${SESSIONS_PATH}`);
  console.log(`[mock]   SYSTEM_KEY=${SYSTEM_KEY}`);
});
