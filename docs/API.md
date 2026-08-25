# API Reference — telegram-personal-api

Tài liệu đầy đủ cho toàn bộ API của service. Mọi mô tả dưới đây đọc thẳng từ mã nguồn
(`src/routes/`, `src/listener.ts`), không phải từ đặc tả mong muốn.

- **Base URL mặc định:** `http://localhost:3200`
- **Content-Type:** `application/json` cho mọi request có body
- **Xác thực vào service:** **không có**. Service không kiểm tra bất kỳ header nào của request đến.
  Xem [Bảo mật](#bảo-mật) trước khi mở ra ngoài mạng nội bộ.
- **Xác thực khi service gọi ra:** header `X-System-Key` lấy từ env `SYSTEM_KEY`.

---

## Mục lục

1. [Khái niệm cốt lõi](#1-khái-niệm-cốt-lõi)
2. [Vòng đời sử dụng](#2-vòng-đời-sử-dụng)
3. [Quy ước chung](#3-quy-ước-chung)
4. [Kiểu dữ liệu dùng lại](#4-kiểu-dữ-liệu-dùng-lại)
5. [Health](#5-health)
6. [Sessions — phiên đăng nhập](#6-sessions--phiên-đăng-nhập)
7. [Messages — gửi tin](#7-messages--gửi-tin)
8. [Sync — hội thoại và lịch sử](#8-sync--hội-thoại-và-lịch-sử)
9. [Media — ảnh và tệp](#9-media--ảnh-và-tệp)
10. [Webhook service GỬI RA](#10-webhook-service-gửi-ra)
11. [Endpoint upstream PHẢI cung cấp](#11-endpoint-upstream-phải-cung-cấp)
12. [Giới hạn đã biết](#12-giới-hạn-đã-biết)
13. [Bảo mật](#bảo-mật)

---

## 1. Khái niệm cốt lõi

| Khái niệm | Nghĩa |
|---|---|
| `accountId` | ID Telegram của tài khoản đã đăng nhập. Khoá định danh phiên trong hầu hết endpoint. |
| `qrToken` | Mã tạm của một lượt quét QR. **Chỉ** dùng cho `/sessions/init-qr`, `/sessions/:qrToken/status` và `/sessions/:qrToken/password`. Sau khi đăng nhập xong thì chuyển sang `accountId`. |
| `threadId` | ID hội thoại: id đối tác (chat riêng) hoặc id NHÓM (chat nhóm). |
| `msgId` | ID tin của Telegram. **Chỉ duy nhất trong MỘT hội thoại** — xem `dedupKey`. |
| `dedupKey` | `{threadId}:{msgId}`. Khoá khử trùng đúng; dùng riêng `msgId` là nuốt tin. |
| `sessionString` | Chuỗi phiên GramJS. Đủ để đăng nhập lại mà không quét QR — đối xử như mật khẩu. |
| upstream | Hệ thống của bạn — nơi service đẩy tin về, nơi cấp phiên để khôi phục, và nơi gọi ngược vào lấy ảnh/tệp. |

**Phiên nằm trong RAM.** Restart service là mất hết phiên đang giữ; service sẽ tự gọi upstream lấy
`sessionString` để đăng nhập lại (xem [mục 11](#11-endpoint-upstream-phải-cung-cấp)).

---

## 2. Vòng đời sử dụng

```
1. POST /sessions/init-qr                → nhận ảnh QR + qrToken
2. Người dùng quét QR bằng app Telegram
3. GET  /sessions/:qrToken/status        → poll; ảnh QR ĐỔI ~30s một lần, phải vẽ lại
   ├─ status = password_required         → POST /sessions/:qrToken/password
   └─ status = confirmed                 → nhận accountId + sessionString (LƯU LẠI!)
4. Dùng accountId cho mọi API còn lại
5. Tin đến tự chảy về upstream qua webhook (mục 10)
6. POST /sessions/:accountId/sync        → nạp lịch sử cũ (tuỳ chọn)
```

> **Poll `/status` phải vẽ lại ảnh QR mỗi vòng.** Telegram làm mới token khoảng 30 giây một lần và
> token cũ chết ngay. Giữ tấm đầu tiên là người dùng quét phải mã đã chết, app chỉ báo "mã không
> hợp lệ" và **không có gì ở phía bạn biết chuyện đó xảy ra**.

---

## 3. Quy ước chung

### Mã trạng thái

| Mã | Nghĩa | Nên làm gì |
|---|---|---|
| `200` | Thành công | — |
| `202` | Đã nhận, chạy nền (chỉ `/sync`) | Theo dõi bằng số tin nhận được, không bằng response |
| `204` | Thành công, không body (chỉ `DELETE /sessions/:accountId`) | — |
| `400` | Thiếu tham số bắt buộc | Sửa request; retry vô ích |
| `404` | Không tìm thấy phiên / qrToken | Đăng nhập lại |
| `409` | Phiên không đang chờ mật khẩu | Đọc lại `/status` |
| `413` | Tệp vượt 25 MB (chỉ `/media`) | Không lấy được qua đường này |
| `500` | Lỗi nội bộ (chỉ `/sessions/init-qr`) | Xem `error` |
| `502` | **Telegram từ chối hoặc không tải được tệp** | Xem `error` để phân biệt hai phía |
| `503` | Phiên tồn tại nhưng chưa `confirmed` | Chờ rồi thử lại |

> **`502` là cố ý, không phải `500`.** Nó nói "hỏng nằm ở phía Telegram / phía kho tệp, không phải
> ở service này" — upstream cần phân biệt để quyết định có retry không.

### Hình dạng lỗi

```jsonc
{ "error": "câu tiếng Việt mô tả chuyện gì hỏng" }
```

Riêng `/send-file` phân biệt rõ hai nguồn hỏng trong `error`:
- *"Không tải được tệp từ kho (HTTP 403) — liên kết có thể đã hết hạn"* → hỏng ở bước **lấy** tệp
- các lỗi còn lại → Telegram từ chối

Phân biệt này quan trọng: gộp chung thì người đọc log đi tìm nhầm phía Telegram.

---

## 4. Kiểu dữ liệu dùng lại

### Attachment

Xuất hiện trong payload webhook. Trường có mặt tuỳ theo `type`:

```jsonc
// ảnh / video / audio / file / sticker
{ "type": "image", "url": "http://.../media/{acc}/{thread}/{msg}", "name": "photo_7.jpg",
  "mimeType": "image/jpeg", "size": 12345 }

// vị trí
{ "type": "location", "latitude": 10.77, "longitude": 106.69 }

// danh thiếp
{ "type": "contact", "name": "Nguyễn Văn A", "phone": "+84..." }

// loại chưa nhận ra — GIỮ LẠI kèm className thật, không nuốt
{ "type": "unknown", "className": "MessageMediaPoll", "url": "..." }
```

> `url` trỏ về **chính service này**, không phải CDN Telegram — xem [mục 9](#9-media--ảnh-và-tệp).
> Nó chỉ tải được khi phiên còn sống.

### PeerKind

`"user"` · `"bot"` · `"group"` · `"channel"` · `"unknown"`

Nhóm siêu lớn (megagroup) được quy về `"group"`; kênh phát một chiều là `"channel"`.

### SessionStatus

| Giá trị | Nghĩa |
|---|---|
| `waiting` | Đã sinh QR, chưa ai quét |
| `password_required` | Đã quét, tài khoản bật mật khẩu hai lớp — đang chờ nhập |
| `password_invalid` | Mật khẩu vừa nộp bị sai; vẫn cho nhập lại |
| `confirmed` | Đăng nhập xong, phiên dùng được |
| `expired` | Hết hạn cả phiên, hoặc hết giờ chờ mật khẩu |
| `error` | Hỏng vì lý do khác — xem `errorReason` |

> **Không có trạng thái "đã quét".** Telegram chỉ báo khi việc đã xong. Tín hiệu duy nhất cho biết
> người dùng vừa quét là lúc nó đòi mật khẩu hai lớp — mà chỉ tài khoản có bật hai lớp mới đi qua
> nhánh đó. Đừng dựng bước "đã quét" trên giao diện: không quan sát được.

---

## 5. Health

### `GET /health`

Kiểm tra process còn sống. **Không** phản ánh sức khoẻ phiên Telegram — dùng
[`GET /sessions/:accountId/health`](#get-sessionsaccountidhealth) cho việc đó.

**Response `200`**

```json
{ "ok": true, "sessions": 2, "confirmed": 1 }
```

---

## 6. Sessions — phiên đăng nhập

### `POST /sessions/init-qr`

Mở một phiên đăng nhập, trả về **tấm QR đầu tiên**. Việc đăng nhập chạy nền sau đó.

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `tempAccountId` | string | Không | Nhãn tạm của bạn để đối chiếu trước khi biết `accountId` thật |

**Response `200`**

```jsonc
{
  "qrToken": "a1b2c3d4...",
  "qrImageUrl": "data:image/png;base64,iVBORw0...",  // nhúng thẳng vào <img src>
  "expiresIn": 300                                    // hạn CẢ PHIÊN, không phải hạn một mã QR
}
```

**Lỗi:** `500` — Telegram không trả QR trong 30 giây, hoặc `api_id` sai (thông báo nói rõ lý do
thật thay vì đổ cho mạng).

---

### `GET /sessions/:qrToken/status`

Poll tiến trình đăng nhập. Nên gọi mỗi 2s và **vẽ lại `qrImageUrl` mỗi lần**.

**Response `200`**

```jsonc
{
  "status": "waiting",
  "accountId": null,
  "displayName": null,
  "username": null,
  "phone": null,
  "avatarUrl": null,
  "sessionString": null,      // chỉ có khi confirmed — PHẢI LƯU
  "qrImageUrl": "data:...",   // ĐỔI ~30s một lần
  "passwordHint": null,       // có khi status = password_required/invalid
  "errorReason": null
}
```

**Lỗi:** `404` — `qrToken` không tồn tại hoặc đã hết hạn.

> Phiên chưa `confirmed` mà quá **10 phút** bị dọn khỏi bộ nhớ; sau đó poll nhận `404`.
> Endpoint này nhận **qrToken**, không phải `accountId` — truyền nhầm sẽ luôn ra `404`.

---

### `POST /sessions/:qrToken/password`

Nộp mật khẩu hai lớp. Chỉ tài khoản có bật hai lớp mới đi qua đây.

**Body:** `password` (string, bắt buộc, không rỗng)

**Response `200`:** `{ "accepted": true }`

**Lỗi:** `400` thiếu mật khẩu · `404` không tìm thấy phiên · `409` phiên không đang chờ mật khẩu.

> **`accepted: true` KHÔNG có nghĩa là mật khẩu đúng** — mới chỉ chuyển được chuỗi cho Telegram.
> Đúng hay sai phải đọc ở `/status`: sai thì `status` thành `password_invalid` và Telegram hỏi lại.
> Hết giờ chờ (mặc định 3 phút) thì `status` thành `expired`.

---

### `GET /sessions/:accountId/health`

Trả lời "phiên này có **thực sự** nhận được tin không". Hai tầng bằng chứng, cố ý không suy diễn:
`lastEventAt` (lần cuối Telegram đẩy về bất cứ thứ gì) và một lời gọi `getMe()` **thật** lên
Telegram.

**Response `200` — phiên chưa đăng ký**

```json
{ "healthy": false, "registered": false, "connected": false, "reason": "no_session" }
```

`reason` là `"no_session"` hoặc `"status=<trạng thái>"`.

**Response `200` — phiên đã đăng ký**

```jsonc
{
  "healthy": true,              // kết quả getMe() THẬT
  "registered": true,
  "connected": true,            // trạng thái kết nối MTProto
  "lastEventAt": 1735689600000,
  "secondsSinceLastEvent": 12,
  "probeError": null            // có nội dung khi healthy=false
}
```

> Suy ra "còn sống" từ việc đã đăng nhập thành công là cách hỏng kinh điển: nó đúng vĩnh viễn kể cả
> sau khi đường đã đứt hàng giờ. `healthy=false` mà `connected=true` ⇒ phiên đã bị thu hồi từ app
> Telegram, cần quét QR lại.

---

### `GET /sessions`

Chẩn đoán — liệt kê mọi phiên trong bộ nhớ.

**Response `200`**

```jsonc
{ "sessions": [{ "accountId": "532...", "status": "confirmed", "displayName": "A", "connected": true }] }
```

---

### `DELETE /sessions/:accountId`

Ngắt kết nối và xoá **mọi** entry của tài khoản. **Luôn trả `204`**, kể cả khi không có phiên nào.

> Đây là ngắt phía service. Phiên Telegram vẫn còn hiệu lực; `sessionString` đã lưu vẫn dùng lại
> được. Muốn thu hồi thật thì đăng xuất thiết bị từ app Telegram.

---

## 7. Messages — gửi tin

Mọi endpoint dưới đây nằm dưới `/sessions/:accountId/`, đều trả `404` khi không có phiên và `503`
khi phiên chưa `confirmed`.

### `POST /sessions/:accountId/send-text`

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `threadId` | string | ✅ | Hội thoại đích |
| `text` | string | ✅ | Không được rỗng |
| `replyToMsgId` | string/number | Không | Trả lời một tin cụ thể |

**Response `200`**

```json
{ "msgId": "11", "dedupKey": "123456789:11" }
```

> **Dùng `dedupKey` trả về để ghim tin vừa gửi.** Trình nghe sẽ nhận lại **chính tin này** ở chiều
> `Out` (tài khoản thật thấy cả tin mình gửi) — không khử trùng thì nó vào hộp thư lần thứ hai.

---

### `POST /sessions/:accountId/send-file`

**Body**

| Field | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `threadId` | string | ✅ | |
| `fileUrl` | string | ✅ | URL service **tải về ngay** trong lời gọi này |
| `fileName` | string | Không | Mặc định `file_{timestamp}` |
| `kind` | string | Không | `"image"` / `"video"` → hiện trong khung chat; còn lại → tệp đính kèm |
| `caption` | string | Không | Chú thích |
| `mimeType` | string | Không | Chỉ để ghi log |
| `replyToMsgId` | string/number | Không | |

**Response `200`:** `{ "msgId": "22", "dedupKey": "..." }`

> **MTProto không nhận URL** — khác Bot API. Tệp phải nằm trong bộ nhớ rồi mới tải lên, nên
> `fileUrl` được lấy về **ngay lập tức**; nếu đó là liên kết ký sẵn có hạn thì đừng hoãn lời gọi này.
>
> **Quên `kind: "image"` là ảnh hiện ra như tệp .jpg phải bấm tải về** — vẫn "gửi thành công", chỉ
> là khách phải thao tác thêm.

---

### `POST /sessions/:accountId/typing`

Báo "đang gõ". **Body:** `threadId` ✅ · **Response:** `{ "ok": true }`

> Telegram tự tắt chỉ báo sau ~6 giây nên **không có** đường tắt riêng: cứ gõ tiếp thì gọi lại.

---

### `POST /sessions/:accountId/react`

Thả / đổi / **gỡ** cảm xúc — cùng một endpoint.

**Body:** `threadId` ✅ · `msgId` ✅ · `emoji` (bỏ trống hoặc rỗng = **GỠ**)

**Response `200`:** `{ "ok": true }`

> Telegram dùng cùng một lời gọi cho cả ba việc: danh sách reaction rỗng nghĩa là gỡ. Gửi kèm emoji
> khi muốn gỡ sẽ thành **thả lại**.

---

### `POST /sessions/:accountId/unsend`

Thu hồi tin ở **cả hai phía** (`revoke: true`).

**Body:** `threadId` ✅ · `msgId` ✅ · **Response `200`:** `{ "ok": true }`

> Không có chế độ "chỉ xoá phía mình" ở đây — đó đúng là thứ người bấm "thu hồi" tưởng đã tránh được.

---

### `POST /sessions/:accountId/mark-read`

**Body:** `threadId` ✅ · **Response `200`:** `{ "ok": true }`

---

## 8. Sync — hội thoại và lịch sử

### `GET /sessions/:accountId/dialogs`

Danh sách hội thoại, để upstream dựng liên hệ.

**Query:** `limit` (mặc định `SYNC_DIALOG_LIMIT` = 200)

**Response `200`**

```jsonc
{
  "dialogs": [{
    "threadId": "123456789",
    "kind": "user",
    "name": "Nguyễn Văn A",
    "username": "nguyenvana",
    "phone": null,
    "avatarUrl": "http://.../avatars/{acc}/{peer}",
    "unreadCount": 3,
    "lastMessageAt": 1735689600000
  }]
}
```

**Lỗi:** `404` không có phiên · `503` chưa sẵn sàng · `502` Telegram từ chối.

---

### `POST /sessions/:accountId/sync`

Nạp lịch sử về upstream. **Đây là thứ đường Bot vĩnh viễn không làm được.**

**Body:** `dialogLimit` (mặc định 200) · `messageLimit` (mặc định 50, cho MỖI hội thoại)

**Response `202`:** `{ "accepted": true }`

> **Trả về ngay và chạy nền** — 200 hội thoại × 50 tin vượt xa mọi hạn chờ HTTP hợp lý. Theo dõi
> tiến độ bằng **số tin upstream thực sự nhận được**, không bằng response này.
>
> Tin được đẩy theo thứ tự **cũ → mới** (Telegram trả ngược lại, service tự đảo) và mang thêm cờ
> `isHistory: true`. Kênh phát một chiều (`channel`) bị bỏ qua mặc định — chúng là bản tin, không
> phải hội thoại của khách.

---

## 9. Media — ảnh và tệp

Hai đường này **upstream gọi vào**, không phải trình duyệt.

### `GET /avatars/:accountId/:peerId`

Trả ảnh JPEG, `Cache-Control: public, max-age=3600`.

**Lỗi:** `404` liên hệ chưa đặt ảnh (là chuyện thường, **không phải** sự cố) · `503` phiên chưa sẵn sàng.

### `GET /media/:accountId/:threadId/:messageId`

Trả tệp đính kèm của một tin, `Content-Type` theo tệp.

**Lỗi:** `404` tin không có tệp / không tải được · `413` tệp **> 25 MB** · `503` phiên chưa sẵn sàng.

> Telegram không có URL công khai cho bất cứ tệp nào — chúng chỉ tải được qua một phiên đã đăng
> nhập. Vì vậy hai đường này tồn tại. Hệ quả: **tệp chỉ lấy được khi phiên còn sống** — upstream
> nên sao lưu về kho của mình ngay, đừng lưu URL rồi tải sau.

---

## 10. Webhook service GỬI RA

Service POST vào **một đường duy nhất** (khác các kênh có nhiều loại sự kiện):

```
POST {UPSTREAM_BASE_URL}{UPSTREAM_WEBHOOK_PATH}
Headers: Content-Type: application/json, X-System-Key: <SYSTEM_KEY>
```

**Payload**

```jsonc
{
  "accountId": "5320747093",
  "threadId": "123456789",     // hội thoại. Nhóm: id NHÓM, KHÔNG phải người gửi
  "peerKind": "user",
  "senderId": "555",           // người viết — trong nhóm thì KHÁC threadId
  "senderName": "Nguyễn Văn A",
  "senderAvatar": "http://.../avatars/...",
  "content": "chào shop",
  "attachments": [],
  "msgId": "42",
  "dedupKey": "123456789:42",  // {threadId}:{msgId}
  "direction": "In",           // "In" nhận | "Out" chính chủ gửi từ app Telegram
  "replyToMsgId": null,
  "timestamp": 1735689600000,  // mili giây (Telegram tính bằng giây, service đã nhân 1000)
  "threadName": "Nguyễn Văn A",
  "threadAvatar": "http://.../avatars/...",
  "isHistory": true            // chỉ có khi đến từ /sync
}
```

**Kỳ vọng:** trả `2xx`. Trả khác thì service chỉ ghi log.

> ⚠️ **Hai điều phải làm ở phía upstream:**
>
> 1. **Khử trùng theo `dedupKey`, KHÔNG theo `msgId`.** `msgId` của Telegram chỉ duy nhất trong một
>    hội thoại — hai người lạ cùng nhắn tin đầu tiên thì cả hai đều là `id=1`. Dùng riêng `msgId` là
>    nuốt mất tin thứ hai: không lỗi, không log, chỉ là một tin của khách biến mất.
> 2. **`threadId` trong nhóm là id NHÓM.** Lấy nhầm làm người gửi thì mọi tin trong nhóm gộp về một
>    liên hệ mang tên nhóm, và câu trả lời đi thẳng vào nhóm — hiện ra với tất cả thành viên.
>
> Đường đẩy là fire-and-forget, không hàng đợi, không retry. Nhưng tin trượt **lấy lại được** bằng
> `POST /sessions/:accountId/sync` — Telegram giữ lịch sử trên máy chủ của họ.

---

## 11. Endpoint upstream PHẢI cung cấp

Để phiên tự khôi phục sau restart (không phải quét QR lại), upstream cần expose:

```
GET {UPSTREAM_BASE_URL}{UPSTREAM_SESSIONS_PATH}
```

mặc định `/api/v1/channels/telegram-personal/internal/sessions`, nhận header `X-System-Key`.

**Phải trả về mảng:**

```jsonc
[
  {
    "externalId": "5320747093",              // = accountId
    "displayName": "Tên tài khoản",
    "sessionString": "1BQANOTEuMTA4..."      // đúng chuỗi lấy từ /sessions/:qrToken/status
  }
]
```

Service gọi endpoint này **sau khi đã mở cổng** — một service chưa mở cổng trông y hệt một service
đã chết với bên đang hỏi thăm sức khoẻ. Upstream không trả lời thì service vẫn chạy bình thường và
chờ quét QR thủ công.

Với mỗi phiên, service còn **hỏi thẳng Telegram** xem còn hiệu lực không (`isUserAuthorized`) trước
khi gắn trình nghe. Kết nối được **không** có nghĩa là còn đăng nhập — chủ tài khoản có thể đã đá
thiết bị này ra từ app.

---

## 12. Giới hạn đã biết

| Giới hạn | Hệ quả | Cách sống chung |
|---|---|---|
| Chưa từng chạy production | Bản gốc mới quét QR thật một lần trên môi trường thử | Chạy thử kỹ trước khi giao cho khách |
| Webhook fire-and-forget | Upstream 5xx / restart ⇒ trượt tin | Gọi `/sync` để lấy lại — Telegram còn giữ lịch sử |
| Phiên nằm trong RAM | Restart mất hết phiên | Hiện thực endpoint ở [mục 11](#11-endpoint-upstream-phải-cung-cấp) |
| Tệp chỉ tải được khi phiên sống | Lưu URL rồi tải sau sẽ hỏng | Upstream sao lưu về kho của mình ngay |
| Tệp > 25 MB | `/media` trả `413` | Không lấy được qua đường này |
| MTProto cho tài khoản người dùng | Telegram có thể `FLOOD_WAIT` hoặc khoá tài khoản | Đừng gọi dồn dập; tôn trọng `FLOOD_WAIT` |
| `api_id`/`api_hash` bắt buộc | Thiếu là service **dừng ngay lúc khởi động** | Cố ý — để lỗi không nổ muộn ở lần quét QR đầu |

---

## Bảo mật

Ba điểm phải xử lý trước khi đưa lên môi trường thật:

1. **Service không xác thực request đến.** Bất kỳ ai gọi được `http://host:3200` là gửi được tin
   dưới danh nghĩa tài khoản Telegram đó, **và đọc được mọi tệp riêng tư của khách** qua
   `/media/:accountId/:threadId/:messageId` — chỉ cần đoán id. Đây là bề mặt rộng hơn hẳn các kênh
   không tự phục vụ tệp. **Đừng expose ra Internet**; đặt sau reverse proxy có xác thực hoặc giới
   hạn ở mạng nội bộ. `SYSTEM_KEY` chỉ bảo vệ chiều service → upstream.

2. **`sessionString` là chìa khoá toàn quyền vào tài khoản Telegram** — mạnh hơn cookies web thông
   thường vì không gắn thiết bị. Ai có nó là đọc được mọi hội thoại. Upstream phải mã hoá khi lưu,
   và **không bao giờ** trả nó ra API công khai.

3. **Log không chứa nội dung tin**, nhưng **có chứa** `accountId`, `threadId`, `msgId`, tên hiển
   thị và số byte tệp. Xử lý log như dữ liệu cá nhân.
