# telegram-personal-api

Backend service cung cấp API cho **Telegram cá nhân** qua **MTProto** — đúng đường mà Telegram
Desktop dùng, không phải Bot API.

Khác biệt không nằm ở giao diện mà ở thứ nhìn thấy được: một con bot chỉ thấy tin gửi cho chính nó,
kể từ lúc bật webhook trở đi. Đăng nhập bằng tài khoản thật thì thấy **mọi hội thoại và toàn bộ
lịch sử**.

```
Telegram  ⇄  telegram-personal-api  ⇄  upstream (hệ thống của bạn)
              ├── webhook out: tin đến / tin tự gửi (một đường duy nhất)
              ├── REST in:     gửi tin, tệp, cảm xúc, thu hồi, nạp lịch sử
              └── serve out:   /avatars/* và /media/* — upstream gọi NGƯỢC vào đây
```

Viết bằng **TypeScript** (strict), biên dịch bằng `tsc` sang `dist/`.

## Yêu cầu

- Node.js 20+
- **`api_id` / `api_hash`** của một ứng dụng đăng ký tại [my.telegram.org](https://my.telegram.org)
  → API development tools. **Đây không phải bot token** — bot token đi đường Bot API, không dùng
  được cho MTProto. Thiếu cặp này thì service **dừng ngay lúc khởi động** (cố ý).
- Tài khoản Telegram thật để quét QR

## Chạy local

```bash
npm ci
cp .env.example .env      # điền TELEGRAM_API_ID, TELEGRAM_API_HASH, UPSTREAM_BASE_URL, SYSTEM_KEY
npm run dev
```

Service lắng nghe ở `http://localhost:3200`, health check tại `GET /health`.

| Lệnh | Việc |
|---|---|
| `npm run build` | Biên dịch `src/` → `dist/` |
| `npm run typecheck` | Kiểm kiểu, không xuất file |
| `npm test` | Build rồi chạy unit test |
| `npm start` | Chạy bản đã build |
| `node scripts/e2e-check.mjs` | Kiểm end-to-end với upstream giả (xem dưới) |

## Docker

```bash
docker compose up -d --build
```

## Cấu hình

Xem đầy đủ ở [`.env.example`](.env.example).

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `TELEGRAM_API_ID` | — | **Bắt buộc.** Từ my.telegram.org |
| `TELEGRAM_API_HASH` | — | **Bắt buộc.** Từ my.telegram.org |
| `PORT` | `3200` | Port service lắng nghe |
| `UPSTREAM_BASE_URL` | `http://localhost:5000` | Base URL hệ thống nhận inbound |
| `UPSTREAM_WEBHOOK_PATH` | `/api/v1/webhook/telegram-personal` | Đường webhook nhận tin đến |
| `UPSTREAM_SESSIONS_PATH` | `/api/v1/channels/telegram-personal/internal/sessions` | Endpoint trả phiên để khôi phục |
| `SYSTEM_KEY` | — | Gửi kèm header `X-System-Key` khi gọi upstream |
| `PUBLIC_BASE_URL` | `http://telegram-personal-api:3200` | Địa chỉ upstream gọi **ngược** vào để lấy ảnh/tệp |

Ba biến `UPSTREAM_*` cho phép cắm service vào bất kỳ hệ thống nào mà không phải sửa mã.

## Phụ thuộc hai chiều — điểm khác các kênh khác

Telegram **không có URL công khai cho bất cứ tệp nào**. Ảnh đại diện và tệp đính kèm chỉ tải được
qua một phiên đã đăng nhập. Vì vậy service **tự phục vụ** chúng tại `/avatars/*` và `/media/*`, và
upstream gọi ngược vào theo `PUBLIC_BASE_URL` rồi sao lưu về kho của mình.

Nghĩa là hai bên phải **gọi được nhau**, không chỉ một chiều như các kênh có CDN công khai.

## API

📘 **[Tài liệu API đầy đủ → `docs/API.md`](docs/API.md)** — mọi endpoint kèm input, output,
mã lỗi, payload webhook và các bẫy đã biết.

| Nhóm | Prefix | Nội dung chính |
|---|---|---|
| Phiên | `/sessions` | QR đăng nhập, mật khẩu hai lớp, trạng thái, sức khoẻ phiên |
| Tin nhắn | `/sessions/:accountId/...` | Gửi text, tệp, đang gõ, cảm xúc, thu hồi, đánh dấu đã đọc |
| Đồng bộ | `/sessions/:accountId/...` | Liệt kê hội thoại, nạp lịch sử về upstream |
| Danh bạ | `/sessions/:accountId/contacts`, `/resolve` | Đọc danh bạ, thêm liên hệ, tra người để mở hội thoại mới |
| Nhóm | `/sessions/:accountId/groups/:groupId/...` | Thành viên, thêm/xoá thành viên, đổi tên |
| Tệp | `/avatars`, `/media` | Phục vụ ảnh đại diện và tệp đính kèm cho upstream |

> **Service không xác thực request đến.** Ai gọi được cổng 3200 là gửi được tin dưới danh nghĩa
> tài khoản Telegram đó, **và đọc được mọi tệp riêng tư của khách** qua `/media/*`. Đừng expose ra
> Internet. Xem [phần Bảo mật](docs/API.md#bảo-mật).

## Kiểm thử không cần upstream thật

`scripts/mock-upstream.mjs` dựng một upstream giả theo **đúng contract của NextX Comm** (đọc từ
`TelegramPersonalWebhookController` và `TelegramPersonalSessionDto`): một đường webhook + endpoint
cấp phiên, xác thực `X-System-Key` fail-closed y như thật.

```bash
npm run build
node scripts/e2e-check.mjs     # dựng mock + service, đo 25 điểm, in bảng kết quả
```

Kiểm được: service dừng ngay khi thiếu `api_id`, gọi đúng endpoint upstream kèm đúng header, đọc
được DTO phiên, chịu được `sessionString` hỏng mà không sập, và mã trạng thái của từng route khi
chưa có phiên. **Không** kiểm được luồng tin thật — cái đó cần người quét QR bằng app Telegram.

## Đồng bộ với bản gốc

Repo tách ra từ một bản nội bộ, không mang lịch sử git. Mốc đã bê sang và cách lấy phần mới nằm ở
[`docs/SYNC.md`](docs/SYNC.md).

## Giới hạn đã biết

- **Chưa từng chạy production.** Bản gốc mới quét QR thật một lần trên môi trường thử nghiệm.
- Đường đẩy inbound là **fire-and-forget**: không hàng đợi, không retry. Nhưng khác các nền tảng
  khác, Telegram giữ lịch sử trên máy chủ của họ — tin trượt **lấy lại được** bằng một lần
  `POST /sessions/:accountId/sync`.
- Payload từ GramJS được khai kiểu **lỏng có chủ đích** (`TgRaw` trong `src/types.ts`): các đối
  tượng MTProto là union rất rộng, phân biệt lúc chạy bằng `className`. Kiểu chặt được áp cho thứ
  service **tự dựng** — payload đẩy đi upstream, hình dạng phiên, kết quả bóc tin.
- API MTProto dùng cho tài khoản người dùng: Telegram có thể giới hạn tần suất (`FLOOD_WAIT`) hoặc
  khoá tài khoản nếu dùng quá mạnh tay.

## Giấy phép

Private.
