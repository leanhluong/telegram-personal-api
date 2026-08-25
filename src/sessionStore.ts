import type {
  ConnState, SessionRecord, SessionStatus, SessionSummary, TgClient,
} from './types.js';

/**
 * Kho phiên trong RAM: `key → phiên`.
 *
 * Key có hai dạng, cố ý:
 *   - `qrToken`              — phiên sinh ra từ một lần quét QR
 *   - `restored_{accountId}` — phiên dựng lại lúc service khởi động
 *
 * Cùng một accountId có thể có nhiều entry (quét lại QR trong khi phiên cũ còn sống). Mọi hàm tra
 * cứu theo accountId đều trả **phiên mới nhất**: tra ra phiên cũ đã bị máy chủ vô hiệu hoá thì tin
 * đến vẫn chạy qua phiên mới, còn tin gửi đi chết ở phiên cũ. Inbound sống, outbound chết, và không
 * có lỗi nào nói ra điều đó.
 */

const store = new Map<string, SessionRecord>();

/** Các trạng thái một phiên đăng nhập có thể ở. */
export const Status = {
  /** Đã sinh QR, chưa ai quét. */
  Waiting: 'waiting',
  /** Đã quét, tài khoản bật mật khẩu hai lớp — đang chờ người dùng nhập. */
  PasswordRequired: 'password_required',
  /** Sai mật khẩu hai lớp; vẫn còn cho nhập lại. */
  PasswordInvalid: 'password_invalid',
  /** Đăng nhập xong, phiên dùng được. */
  Confirmed: 'confirmed',
  /** Hết hạn cả phiên (người dùng mở hộp thoại rồi bỏ đi). */
  Expired: 'expired',
  /** Hỏng vì lý do khác — xem `errorReason`. */
  Error: 'error',
} as const satisfies Record<string, SessionStatus>;

export interface CreateSessionOptions {
  client?: TgClient | null;
  tempAccountId?: string | null;
}

export function createSession(
  key: string,
  { client = null, tempAccountId = null }: CreateSessionOptions = {},
): SessionRecord {
  store.set(key, {
    client,
    tempAccountId,
    status: Status.Waiting,
    accountId: null,
    displayName: null,
    username: null,
    phone: null,
    avatarUrl: null,
    sessionString: null,
    qrImageUrl: null,
    qrUpdatedAt: null,
    passwordHint: null,
    submitPassword: null,
    errorReason: null,
    createdAt: Date.now(),
    // Trạng thái đường truyền — /health đọc từ đây. Suy ra "còn sống" từ việc đăng nhập đã từng
    // thành công là cách hỏng kinh điển: nó đúng vĩnh viễn kể cả khi đường đã đứt từ lâu.
    connected: false,
    lastEventAt: null,
  });
  return store.get(key)!;
}

export function getSession(key: string): SessionRecord | null {
  return store.get(key) ?? null;
}

export function updateSession(key: string, patch: Partial<SessionRecord>): SessionRecord | null {
  const s = store.get(key);
  if (!s) return null;
  const next = { ...s, ...patch };
  store.set(key, next);
  return next;
}

/** Phiên MỚI NHẤT của accountId — xem ghi chú đầu file về vì sao phải là mới nhất. */
export function getSessionByAccountId(accountId: string | null | undefined): SessionRecord | null {
  let latest: SessionRecord | null = null;
  for (const s of store.values()) {
    if (s.accountId !== accountId) continue;
    if (latest === null || (s.createdAt ?? 0) > (latest.createdAt ?? 0)) latest = s;
  }
  return latest;
}

function latestKeyOf(accountId: string | null | undefined): string | null {
  let latestKey: string | null = null;
  let latestAt = -1;
  for (const [k, s] of store.entries()) {
    if (s.accountId !== accountId) continue;
    const at = s.createdAt ?? 0;
    if (at > latestAt) { latestAt = at; latestKey = k; }
  }
  return latestKey;
}

/** Ghi trạng thái đường truyền cho phiên mới nhất của accountId. */
export function markConnState(accountId: string | null | undefined, patch: ConnState): boolean {
  const key = latestKeyOf(accountId);
  if (!key) return false;
  const existing = store.get(key);
  if (!existing) return false;
  store.set(key, { ...existing, ...patch });
  return true;
}

/** Đóng dấu "vừa nhận sự kiện từ Telegram" — bằng chứng duy nhất cho thấy phiên còn thở. */
export function touchSession(accountId: string | null | undefined): boolean {
  return markConnState(accountId, { lastEventAt: Date.now(), connected: true });
}

async function disconnectQuietly(session: SessionRecord | undefined, tag: string): Promise<void> {
  try {
    await session?.client?.disconnect?.();
  } catch (err) {
    console.warn(`[sessionStore] ${tag}: disconnect lỗi:`, (err as Error)?.message);
  }
}

/**
 * Phiên `keepKey` trở thành phiên duy nhất của accountId; mọi phiên cũ bị ngắt và xoá.
 *
 * Bỏ bước này thì Map phình theo số lần quét QR và **mỗi phiên cũ vẫn giữ một kết nối MTProto
 * đang nghe** — tin của khách được đẩy về upstream nhiều lần, mỗi phiên một lần.
 */
export async function adoptSession(keepKey: string, accountId: string): Promise<number> {
  let dropped = 0;
  for (const [k, s] of store.entries()) {
    if (k === keepKey || s.accountId !== accountId) continue;
    await disconnectQuietly(s, `adoptSession(${accountId})`);
    store.delete(k);
    dropped++;
  }
  if (dropped > 0) {
    console.log(`[sessionStore] adoptSession: bỏ ${dropped} phiên cũ của account ${accountId}`);
  }
  return dropped;
}

/** Xoá MỌI entry của accountId. */
export async function deleteSession(accountId: string): Promise<number> {
  let removed = 0;
  for (const [k, s] of store.entries()) {
    if (s.accountId !== accountId) continue;
    await disconnectQuietly(s, `deleteSession(${accountId})`);
    store.delete(k);
    removed++;
  }
  return removed;
}

export function listSessions(): SessionSummary[] {
  return Array.from(store.values()).map((s) => ({
    accountId: s.accountId,
    status: s.status,
    displayName: s.displayName,
    connected: s.connected,
  }));
}

/**
 * Dọn phiên đăng nhập dở dang.
 *
 * `unref()` để timer không giữ vòng lặp sự kiện sống — thiếu nó thì `node --test` treo vĩnh viễn
 * thay vì thoát khi chạy xong.
 */
export function startJanitor(maxAgeMs = 10 * 60 * 1000): NodeJS.Timeout {
  return setInterval(async () => {
    const now = Date.now();
    for (const [k, s] of store.entries()) {
      const stale = s.status !== Status.Confirmed && now - s.createdAt > maxAgeMs;
      if (!stale) continue;
      await disconnectQuietly(s, `janitor(${k})`);
      store.delete(k);
    }
  }, 60 * 1000).unref();
}

/** Chỉ dùng trong test. */
export function _clear(): void {
  store.clear();
}
