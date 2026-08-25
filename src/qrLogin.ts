import { v4 as uuidv4 } from 'uuid';
import QRCode from 'qrcode';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { createSession, getSession, updateSession, adoptSession, Status } from './sessionStore.js';
import { describeSelf } from './peers.js';
import { errMsg } from './errors.js';
import type { Config, SessionRecord, TgRaw } from './types.js';

/**
 * Đăng nhập bằng QR — đúng đường mà nút "Link Desktop Device" trong app Telegram dùng.
 *
 * <h3>Ba điều dễ giả định sai</h3>
 *
 * <b>1. Mã QR ĐỔI liên tục.</b> Telegram làm mới token khoảng 30 giây một lần và token cũ chết
 * ngay. Trả một tấm QR duy nhất rồi để yên là hộp thoại hiện mã đã chết sau nửa phút — người dùng
 * quét, app báo lỗi, và không có gì ở phía ta biết chuyện đó xảy ra. Nên phiên giữ tấm MỚI NHẤT ở
 * <c>qrImageUrl</c> và màn hình phải đọc lại theo nhịp.
 *
 * <b>2. Không có trạng thái "đã quét" riêng.</b> Telegram chỉ báo khi việc đã xong. Tín hiệu duy
 * nhất cho biết người dùng vừa quét là lúc nó đòi mật khẩu hai lớp — mà chỉ tài khoản có bật hai
 * lớp mới đi qua nhánh đó. Trạng thái ở đây phản ánh đúng chừng đó, không bịa thêm bước "đã quét"
 * mà ta không quan sát được.
 *
 * <b>3. Có thể phải nhập mật khẩu hai lớp.</b> Lời gọi đăng nhập của GramJS <b>chờ</b> ở hàm
 * <c>password</c>. Không ai trả lời thì nó chờ mãi và giữ nguyên một kết nối MTProto — rò rỉ chậm,
 * gần như không thể nhìn ra. Vì vậy chỗ chờ luôn có hạn giờ (<c>passwordTimeoutMs</c>).
 */

const QR_READY_TIMEOUT_MS = 30_000;

/** Bọc một promise bằng hạn giờ để không có nhánh nào chờ vô hạn. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Chờ người dùng nộp mật khẩu hai lớp.
 *
 * Trả về một promise được giải phóng bởi {@link submitPassword}. Hạn giờ là bắt buộc — xem ghi chú
 * (3) ở đầu file.
 */
function waitForPassword(qrToken: string, hint: string | undefined, timeoutMs: number): Promise<string> {
  const session = getSession(qrToken);
  const alreadyAsked = session?.passwordHint !== null && session?.passwordHint !== undefined;

  return new Promise<string>((resolve, reject) => {
    updateSession(qrToken, {
      // Lần hỏi đầu = vừa quét xong. Lần hỏi lại = mật khẩu vừa nộp bị sai; nói thẳng ra thay vì
      // để màn hình đứng im ở "đang chờ mật khẩu" mà người dùng tưởng mình chưa bấm gửi.
      status: alreadyAsked ? Status.PasswordInvalid : Status.PasswordRequired,
      passwordHint: hint ?? '',
      submitPassword: resolve,
    });

    setTimeout(() => {
      const s = getSession(qrToken);
      if (s?.submitPassword !== resolve) return; // đã có người nộp, hạn giờ này vô nghĩa
      updateSession(qrToken, {
        status: Status.Expired,
        submitPassword: null,
        errorReason: 'Hết thời gian chờ nhập mật khẩu hai lớp',
      });
      reject(new Error('PASSWORD_TIMEOUT'));
    }, timeoutMs).unref?.();
  });
}

export interface SubmitPasswordResult {
  ok: boolean;
  reason?: 'not_found' | 'not_waiting';
}

/** Nhận mật khẩu từ tầng HTTP và giải phóng lời gọi đăng nhập đang chờ. */
export function submitPassword(qrToken: string, password: string): SubmitPasswordResult {
  const session = getSession(qrToken);
  if (!session) return { ok: false, reason: 'not_found' };
  if (typeof session.submitPassword !== 'function') return { ok: false, reason: 'not_waiting' };

  const resolve = session.submitPassword;
  // Xoá trước khi gọi: GramJS hỏi lại ngay trong cùng nhịp khi mật khẩu sai, và hàm hỏi lại sẽ tự
  // đặt submitPassword mới. Xoá sau thì cái mới bị ghi đè bằng null và lần nộp kế tiếp rơi vào
  // hư không — người dùng bấm gửi mãi không có gì xảy ra.
  updateSession(qrToken, { submitPassword: null });
  resolve(password);
  return { ok: true };
}

export interface StartQrLoginOptions {
  tempAccountId?: string | null;
  onReady?: (session: SessionRecord | null) => void | Promise<void>;
}

export interface StartQrLoginResult {
  qrToken: string;
  qrImageUrl: string;
  expiresIn: number;
}

/**
 * Mở một phiên đăng nhập QR. Trả về ngay khi có tấm QR ĐẦU TIÊN; phần còn lại chạy nền và ghi kết
 * quả vào kho phiên để đường `/status` đọc.
 */
export async function startQrLogin(
  cfg: Config, { tempAccountId = null, onReady }: StartQrLoginOptions = {},
): Promise<StartQrLoginResult> {
  const qrToken = uuidv4().replace(/-/g, '');
  const client = new TelegramClient(
    new StringSession(''), cfg.apiId, cfg.apiHash,
    { connectionRetries: cfg.connectionRetries, autoReconnect: true });

  await client.connect();
  createSession(qrToken, { client, tempAccountId });

  // `firstQr` phải hỏng được theo CẢ HAI hướng.
  //
  // Đo thật 22/08/2026: với api_id sai, Telegram trả `API_ID_INVALID` sau 2 giây — nhưng lời gọi
  // HTTP vẫn nằm chờ đủ 30 giây rồi trả về "Telegram không trả mã QR trong 30 giây". Thông báo đó
  // chỉ về phía mạng, trong khi nguyên nhân thật đã nằm sẵn trong log từ giây thứ hai. Người đi
  // sửa sẽ đi soi tường lửa thay vì đi xem lại api_id.
  let resolveFirstQr!: (v: { qrImageUrl: string; expires?: unknown }) => void;
  let rejectFirstQr!: (e: Error) => void;
  const firstQr = new Promise<{ qrImageUrl: string; expires?: unknown }>((resolve, reject) => {
    resolveFirstQr = resolve;
    rejectFirstQr = reject;
  });
  // Không ai bắt thì Node coi là lỗi chưa xử lý và giết tiến trình; nhánh thắng cuộc đua sẽ ném ra
  // đúng lỗi này ở dưới.
  firstQr.catch(() => {});

  /** Đưa lỗi lên tận lời gọi HTTP nếu nó xảy ra TRƯỚC khi có tấm QR đầu tiên. */
  const failFast = (reason: string): void => rejectFirstQr(new Error(reason));

  const credentials = { apiId: cfg.apiId, apiHash: cfg.apiHash };

  client.signInUserWithQrCode(credentials, {
    qrCode: async ({ token }: TgRaw) => {
      // Đúng định dạng app Telegram chờ đợi khi quét. Sai một ký tự thì app chỉ báo "mã không hợp
      // lệ" mà không nói vì sao.
      const loginUrl = `tg://login?token=${Buffer.from(token).toString('base64url')}`;
      const qrImageUrl = await QRCode.toDataURL(loginUrl, { width: 320, margin: 1 });
      updateSession(qrToken, { qrImageUrl, qrUpdatedAt: Date.now() });
      resolveFirstQr({ qrImageUrl });
    },

    password: (hint?: string) => waitForPassword(qrToken, hint, cfg.passwordTimeoutMs),

    onError: async (err: TgRaw) => {
      const msg = errMsg(err);

      // Mật khẩu sai — KHÔNG dừng. Trả false để GramJS hỏi lại, và người dùng nhập lại được.
      if (msg.includes('PASSWORD_HASH_INVALID') || msg === 'Password is empty') {
        console.warn(`[qr] ${qrToken}: mật khẩu hai lớp sai, cho nhập lại`);
        return false;
      }

      // Telegram bắt chờ. Thử lại chỉ làm hạn chờ dài thêm.
      if (msg.startsWith('FLOOD_WAIT')) {
        updateSession(qrToken, { status: Status.Error, errorReason: `Telegram yêu cầu chờ: ${msg}` });
        failFast(`Telegram yêu cầu chờ: ${msg}`);
        return true;
      }

      if (msg === 'PASSWORD_TIMEOUT') return true; // trạng thái đã ghi ở waitForPassword

      console.error(`[qr] ${qrToken}: lỗi đăng nhập:`, msg);
      updateSession(qrToken, { status: Status.Error, errorReason: msg });
      failFast(msg);
      return true;
    },
  })
    .then(async (user: TgRaw) => {
      if (!user) return;
      const self = await describeSelf(client, user);

      updateSession(qrToken, {
        status: Status.Confirmed,
        accountId: self.accountId,
        displayName: self.displayName,
        username: self.username,
        phone: self.phone,
        avatarUrl: self.avatarUrl,
        // Đủ để dựng lại phiên mà không cần quét lại. Upstream nên mã hoá trước khi cất xuống DB.
        sessionString: client.session.save() as unknown as string,
        connected: true,
        passwordHint: null,
        submitPassword: null,
      });

      // Phiên vừa đăng nhập là phiên hợp lệ duy nhất của tài khoản này. Không dọn thì mỗi phiên cũ
      // còn lại vẫn đang nghe và đẩy cùng một tin về upstream thêm một lần nữa.
      if (self.accountId) await adoptSession(qrToken, self.accountId);

      console.log(`[qr] ${qrToken}: đăng nhập xong — ${self.displayName} (${self.accountId})`);
      if (typeof onReady === 'function') {
        try {
          await onReady(getSession(qrToken));
        } catch (err) {
          console.error(`[qr] ${qrToken}: onReady lỗi:`, errMsg(err));
        }
      }
    })
    .catch((err: unknown) => {
      const msg = errMsg(err);
      const current = getSession(qrToken);
      // onError đã ghi lý do cụ thể rồi thì giữ nguyên — nó nói được nhiều hơn lỗi bọc ngoài.
      if (current && current.status !== Status.Error && current.status !== Status.Expired) {
        updateSession(qrToken, { status: Status.Error, errorReason: msg });
      }
      console.error(`[qr] ${qrToken}: đăng nhập thất bại:`, msg);
      // Lỗi nào không đi qua onError — ví dụ ném thẳng từ lời gọi đầu tiên — vẫn phải nổi lên tới
      // lời gọi HTTP thay vì để nó chờ hết hạn giờ rồi báo sai nguyên nhân.
      failFast(msg);
    });

  const ready = await withTimeout(
    firstQr, QR_READY_TIMEOUT_MS,
    'Telegram không trả mã QR trong 30 giây');

  return {
    qrToken,
    qrImageUrl: ready.qrImageUrl,
    expiresIn: Math.round(cfg.qrSessionTimeoutMs / 1000),
  };
}
