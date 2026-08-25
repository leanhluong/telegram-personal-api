// Tiện ích đọc lỗi.
//
// Với `strict`, biến trong `catch (err)` có kiểu `unknown` — đúng, vì JS ném được
// bất cứ thứ gì. Riêng GramJS còn ném lỗi mang `errorMessage` (mã lỗi MTProto như
// `PASSWORD_HASH_INVALID`, `FLOOD_WAIT_30`) chứ không phải `message` — đọc nhầm
// trường là mất đúng thông tin cần để phân loại lỗi.

/**
 * Thông điệp lỗi. Ưu tiên `errorMessage` của GramJS vì đó mới là mã MTProto;
 * `message` của cùng lỗi đó thường là câu mô tả chung chung.
 */
export function errMsg(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { errorMessage?: unknown; message?: unknown };
    if (typeof e.errorMessage === 'string' && e.errorMessage.length > 0) return e.errorMessage;
    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
