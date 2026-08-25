import type { Config } from './types.js';

/**
 * Cấu hình service.
 *
 * <b>api_id / api_hash là bắt buộc và không có đường vòng.</b> MTProto — đường mà Telegram Desktop
 * và Telegram Mobile đi — chỉ nhận lời gọi từ một ứng dụng đã đăng ký tại https://my.telegram.org.
 * Đây KHÔNG phải bot token; bot token không dùng được ở đây. Thiếu cặp này thì mọi thứ trong repo
 * này là mã chết.
 *
 * Vì vậy quá trình khởi động **dừng ngay** khi thiếu, thay vì để lỗi nổ ở lần quét QR đầu tiên —
 * lúc đó người dùng đang nhìn màn hình xoay vòng và thông báo trả về chẳng nói lên điều gì.
 */

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(
      `Thiếu biến môi trường ${name}. Lấy tại https://my.telegram.org → API development tools. ` +
      `Đây là api_id/api_hash của ỨNG DỤNG, không phải bot token.`);
  }
  return String(v).trim();
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): Config {
  return {
    apiId: Number(required('TELEGRAM_API_ID')),
    apiHash: required('TELEGRAM_API_HASH'),

    port: optionalInt('PORT', 3200),

    /** Đường quay về hệ thống của bạn. Service chỉ nói chuyện với upstream trong mạng nội bộ. */
    upstreamBaseUrl: process.env.UPSTREAM_BASE_URL ?? 'http://localhost:5000',
    /**
     * Ba biến UPSTREAM_* cho phép cắm service vào bất kỳ hệ thống nào mà không phải sửa mã —
     * chỉ cần hệ đó expose endpoint nhận POST cùng payload.
     */
    upstreamWebhookPath: process.env.UPSTREAM_WEBHOOK_PATH ?? '/api/v1/webhook/telegram-personal',
    upstreamSessionsPath:
      process.env.UPSTREAM_SESSIONS_PATH ?? '/api/v1/channels/telegram-personal/internal/sessions',
    systemKey: process.env.SYSTEM_KEY ?? '',

    /**
     * Địa chỉ upstream gọi ngược lại service để lấy ảnh đại diện và tệp đính kèm.
     *
     * Telegram KHÔNG có URL công khai cho bất cứ tệp nào — ảnh chỉ tải được qua một phiên đã đăng
     * nhập. Nên service tự phục vụ chúng, và upstream sao lưu về kho của mình. Địa chỉ này chỉ nên
     * sống trong mạng nội bộ; ai gọi được là đọc được tệp riêng tư của khách.
     */
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://telegram-personal-api:3200',

    /**
     * Telegram làm mới token QR khoảng mỗi 30 giây. Đây là hạn CẢ PHIÊN đăng nhập (người dùng mở
     * hộp thoại rồi bỏ đi), không phải hạn của một mã QR.
     */
    qrSessionTimeoutMs: optionalInt('QR_SESSION_TIMEOUT_MS', 5 * 60 * 1000),

    /**
     * Thời gian chờ người dùng nhập mật khẩu hai lớp. Hết hạn mà không huỷ thì lời gọi đăng nhập
     * treo vĩnh viễn và giữ luôn một kết nối MTProto — rò rỉ chậm, rất khó nhìn ra.
     */
    passwordTimeoutMs: optionalInt('PASSWORD_TIMEOUT_MS', 3 * 60 * 1000),

    /** Số hội thoại tối đa kéo về trong một lần đồng bộ. */
    syncDialogLimit: optionalInt('SYNC_DIALOG_LIMIT', 200),
    /** Số tin tối đa kéo về cho MỖI hội thoại. */
    syncMessageLimit: optionalInt('SYNC_MESSAGE_LIMIT', 50),

    connectionRetries: optionalInt('CONNECTION_RETRIES', 5),
  };
}
