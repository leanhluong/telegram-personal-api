import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createSession, updateSession, adoptSession, Status } from './sessionStore.js';
import { registerListener } from './listener.js';
import { describeSelf } from './peers.js';
import { errMsg } from './errors.js';
import type { Config, RestoreSummary, UpstreamSession } from './types.js';

/**
 * Dựng lại các phiên đã đăng nhập khi service khởi động.
 *
 * Không có bước này thì mỗi lần triển khai lại là mọi khách phải quét QR lại — và cho tới khi họ
 * quét, kênh vẫn hiện "đã kết nối" trong khi không tin nào tới. Đúng kiểu hỏng không phát ra tín
 * hiệu nào.
 *
 * Chuỗi phiên do upstream giữ (nên mã hoá) và trả về qua đường nội bộ.
 */

async function fetchSessions(cfg: Config): Promise<UpstreamSession[]> {
  const url = `${cfg.upstreamBaseUrl.replace(/\/+$/, '')}${cfg.upstreamSessionsPath}`;
  try {
    const resp = await fetch(url, { headers: { 'X-System-Key': cfg.systemKey } });
    if (!resp.ok) {
      console.warn(`[restore] upstream trả ${resp.status} — không có phiên nào để dựng lại`);
      return [];
    }
    return (await resp.json()) as UpstreamSession[];
  } catch (err) {
    console.warn(`[restore] không gọi được upstream: ${errMsg(err)}`);
    return [];
  }
}

async function restoreOne(
  cfg: Config, { externalId, displayName, sessionString }: UpstreamSession,
): Promise<boolean> {
  if (!sessionString) {
    console.warn(`[restore] ${displayName} (${externalId}): thiếu chuỗi phiên, bỏ qua`);
    return false;
  }

  try {
    const client = new TelegramClient(
      new StringSession(sessionString), cfg.apiId, cfg.apiHash,
      { connectionRetries: cfg.connectionRetries, autoReconnect: true });

    await client.connect();

    // Hỏi THẲNG Telegram phiên còn hiệu lực không. Kết nối thành công KHÔNG có nghĩa là còn đăng
    // nhập — chủ tài khoản có thể đã đá thiết bị này ra từ app. Bỏ qua bước này thì trình nghe được
    // gắn lên một phiên chết và im lặng không nhận gì.
    if (!(await client.isUserAuthorized())) {
      console.warn(`[restore] ${displayName} (${externalId}): phiên đã bị thu hồi — cần quét QR lại`);
      await client.disconnect().catch(() => {});
      return false;
    }

    const self = await describeSelf(client);
    const key = `restored_${externalId}`;
    createSession(key, { client });
    updateSession(key, {
      status: Status.Confirmed,
      accountId: externalId,
      displayName: self.displayName ?? displayName,
      username: self.username,
      phone: self.phone,
      sessionString,
      connected: true,
    });
    await adoptSession(key, externalId);

    registerListener(cfg, client, externalId, { tag: 'restore' });
    console.log(`[restore] ✅ ${self.displayName ?? displayName} (${externalId})`);
    return true;
  } catch (err) {
    console.error(`[restore] ❌ ${displayName} (${externalId}): ${errMsg(err)}`);
    return false;
  }
}

export async function restoreAll(cfg: Config): Promise<RestoreSummary> {
  const sessions = await fetchSessions(cfg);
  if (sessions.length === 0) {
    console.log('[restore] không có phiên nào cần dựng lại');
    return { total: 0, restored: 0, failed: 0 };
  }

  let restored = 0;
  for (const s of sessions) {
    if (await restoreOne(cfg, s)) restored++;
  }

  const result: RestoreSummary = {
    total: sessions.length, restored, failed: sessions.length - restored,
  };
  // Đếm cả hai chiều. Chỉ in số dựng lại được thì một đợt hỏng sạch trông y hệt một đợt không có
  // gì để làm.
  console.log(`[restore] xong — ${JSON.stringify(result)}`);
  return result;
}
