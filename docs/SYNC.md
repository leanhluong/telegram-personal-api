# Mốc đồng bộ với bản gốc

Repo này tách ra từ một bản nội bộ và **không mang lịch sử git của nó**. File này ghi mốc đã bê
sang, để lần sau chỉ cần lấy phần mới thay vì đoán.

## Mốc hiện tại

| | |
|---|---|
| Nguồn | `nextx-telegram-bridge` (private) |
| Nhánh | `develop` |
| Commit đã bê | **`d3a4413a60ab14ed24e8cb43190eee81b443ed9a`** |
| Ngày | 25/08/2026 |
| Nội dung tại mốc | MTProto + QR login + mật khẩu 2 lớp + listener + nạp lịch sử + gửi tệp/typing/reactions/unsend |

Mốc này gồm cả `bda56f5 feat: send files, typing, reactions and unsend over MTProto` — commit nằm
trên `develop` nhưng **chưa có** trong working copy lúc bắt đầu copy. Đó là lý do file này tồn tại:
chép từ thư mục làm việc thay vì từ nhánh đã merge là cách bỏ sót tính năng mà không ai nhận ra.

## Lần sau đồng bộ thế nào

```bash
cd <đường-dẫn>/nextx-telegram-bridge
git fetch origin

# 1. Có gì mới kể từ mốc?
git log --oneline d3a4413..origin/develop

# 2. Chúng đụng vào file nào?
git diff --stat d3a4413 origin/develop

# 3. Xem thay đổi thật để bê tay sang (KHÔNG cherry-pick được: bên này đã là TypeScript
#    và đã bóc hết phần dính hệ thống nội bộ)
git diff d3a4413 origin/develop -- src/
```

Bê xong thì **cập nhật commit ở bảng trên** — mốc sai còn tệ hơn không có mốc.

## Những chỗ đã đổi so với bản gốc — đừng bê đè lên

Bê thay đổi mới sang thì phải giữ lại các quyết định này, nếu không sẽ kéo ngược phần đã bóc:

| Bản gốc | Bản này |
|---|---|
| JavaScript | **TypeScript strict**, build ra `dist/` |
| `COMM_INBOUND_URL` | `UPSTREAM_BASE_URL` |
| Đường webhook hardcode `/api/v1/comm/webhook/telegram-personal` | env `UPSTREAM_WEBHOOK_PATH` |
| Đường sessions hardcode `/api/v1/comm/channels/...` | env `UPSTREAM_SESSIONS_PATH` |
| `BRIDGE_PUBLIC_URL` | `PUBLIC_BASE_URL` |
| `cfg.commInboundUrl` | `cfg.upstreamBaseUrl` |
| CI dùng workflow dùng chung nội bộ | CI standalone (typecheck + test + e2e + docker build) |
| Comment nhắc tên hệ thống nội bộ, MinIO, `IAvatarCacheService` | nói "upstream", "kho của bạn" |
| Dockerfile một tầng | multi-stage (build có devDeps, runtime chỉ prod + `dist`) |

Ngoài ra bản này có thêm, bản gốc không có: `docs/API.md`, `scripts/mock-upstream.mjs`,
`scripts/e2e-check.mjs`, `scripts/run-tests.mjs`, `src/types.ts`, `src/errors.ts`.
