# Mốc đồng bộ với bản gốc

Repo này tách ra từ một bản nội bộ và **không mang lịch sử git của nó**. File này ghi mốc đã bê
sang, để lần sau chỉ cần lấy phần mới thay vì đoán.

## Mốc hiện tại

| | |
|---|---|
| Nguồn | `nextx-telegram-bridge` (private) |
| Nhánh | `develop` |
| Commit đã bê | **`c49bc9d`** (merge PR #3) |
| Ngày | 25/08/2026 |
| Nội dung tại mốc | MTProto + QR login + mật khẩu 2 lớp + listener + nạp lịch sử + gửi tệp/typing/reactions/unsend + **danh bạ & quản lý nhóm** |

### Đã bê những đợt nào

| Commit | Nội dung | Bê ngày |
|---|---|---|
| `43fffef` (PR #1) | Nền: MTProto, QR login, listener, nạp lịch sử | 25/08 |
| `bda56f5` (PR #2) | Gửi tệp, đang gõ, cảm xúc, thu hồi | 25/08 |
| `fd62c75` (PR #3) | Danh bạ, thêm liên hệ, quản lý nhóm (+7 endpoint) | 25/08 |

⚠️ **Bẫy đã dính một lần:** working copy của repo gốc đứng ở nhánh `agent/*` **cũ hơn `develop`**,
thiếu hẳn `bda56f5`. Chép từ thư mục làm việc thay vì từ nhánh đã merge là cách bỏ sót tính năng mà
không ai nhận ra. **Luôn `git archive origin/develop`**, đừng copy thư mục.

## Lần sau đồng bộ thế nào

```bash
cd <đường-dẫn>/nextx-telegram-bridge
git fetch origin

# 1. Có gì mới kể từ mốc?
git log --oneline c49bc9d..origin/develop

# 2. Chúng đụng vào file nào? Có endpoint mới không?
git diff --stat c49bc9d origin/develop
git diff c49bc9d origin/develop -- src/ | grep -E "^\+.*router\.(get|post|put|delete)\("

# 3. Xem thay đổi thật để bê tay sang (KHÔNG cherry-pick được: bên này đã là TypeScript
#    và đã bóc hết phần dính hệ thống nội bộ)
git diff c49bc9d origin/develop -- src/
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
