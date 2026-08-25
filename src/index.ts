import express from 'express';
import { loadConfig } from './config.js';
import { startJanitor, listSessions } from './sessionStore.js';
import { sessionsRouter } from './routes/sessions.js';
import { messagesRouter } from './routes/messages.js';
import { syncRouter } from './routes/sync.js';
import { mediaRouter } from './routes/media.js';
import { restoreAll } from './sessionRestore.js';
import { errMsg } from './errors.js';

/**
 * API cho Telegram cá nhân.
 *
 * Đi đường MTProto — đúng đường Telegram Desktop dùng — chứ không phải Bot API. Khác biệt không
 * nằm ở giao diện mà ở thứ nhìn thấy được: một con bot chỉ thấy tin gửi cho chính nó, kể từ lúc
 * bật webhook. Đăng nhập bằng tài khoản thật thì thấy mọi hội thoại và toàn bộ lịch sử.
 */

const cfg = loadConfig();

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  const sessions = listSessions();
  res.json({
    ok: true,
    sessions: sessions.length,
    confirmed: sessions.filter((s) => s.status === 'confirmed').length,
  });
});

app.use('/sessions', sessionsRouter(cfg));
app.use('/sessions', messagesRouter(cfg));
app.use('/sessions', syncRouter(cfg));
app.use('/', mediaRouter(cfg));

startJanitor();

const server = app.listen(cfg.port, () => {
  console.log(`[service] telegram-personal-api nghe ở cổng ${cfg.port}`);
  // Dựng lại phiên SAU khi đã nghe cổng: upstream có thể đang hỏi thăm sức khoẻ, và một service
  // chưa mở cổng trông y hệt một service đã chết.
  restoreAll(cfg).catch((err) => console.error('[service] dựng lại phiên hỏng:', errMsg(err)));
});

function shutdown(signal: string): void {
  console.log(`[service] nhận ${signal}, đang đóng`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app };
