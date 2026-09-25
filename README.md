# Thư viện điện tử Đảng bộ xã Xuân Giang

Website đọc tài liệu (TTS + highlight), tin tức đề xuất, video Youtube, mindmap
nghiên cứu văn bản, và mục Danh nhân & Địa điểm. Không yêu cầu đăng nhập để
xem/nghe — chỉ khu quản lý (Ban Xây dựng Đảng) có mật khẩu riêng.

## 1. Cài đặt

```bash
npm install
cp .env.example .env   # rồi điền giá trị thật vào .env
npm start
```

Server chạy ở `http://localhost:3000` (hoặc theo biến `PORT` trong `.env`).

## 2. Cấu hình `.env`

Xem chi tiết trong `.env.example`. Tóm tắt các việc cần làm trước khi chạy:

1. **Firebase** — vào Firebase Console → Project Settings → Service Accounts →
   *Generate new private key* (nhớ **thu hồi key cũ** đã từng lộ trên GitHub
   trước khi tạo key mới), điền `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
   `FIREBASE_PRIVATE_KEY`.
2. **Google Sheet tài liệu chính** (`PDF_SHEET_URL`) — File trên Google Sheets
   → File → Share → Publish to web → chọn định dạng CSV → dán link vào `.env`.
3. **Google Sheet Danh nhân & Địa điểm** (`NHANVAT_SHEET_URL`) — sheet riêng,
   publish CSV tương tự.
4. **Mật khẩu khu quản lý** (`ADMIN_PASSWORD`) — mặc định `26071994`, đổi được
   trong `.env` bất cứ lúc nào mà không cần sửa code.

## 3. Cấu trúc Google Sheet

### Sheet tài liệu chính (`PDF_SHEET_URL`)

| Cột | Ý nghĩa |
|---|---|
| `type` | Loại tài liệu (hiển thị ở khối "Danh mục tài liệu") |
| `name` | Tên tài liệu — dùng làm định danh trong URL (`/doc/:name`) |
| `url` | Link file (Google Drive PDF, Google Docs, hoặc Youtube) |
| `summaryD`, `summaryE`, `summaryF` | Tóm tắt dùng cho mindmap (tối đa 3 nhánh) |
| `faceLink` (cột G) | Link trang chủ nguồn tin ngoài (dùng cho "Bài đọc đề xuất") |
| `NguonTrang` (cột H) | Tên hiển thị của nguồn tin đó |

### Sheet Danh nhân & Địa điểm (`NHANVAT_SHEET_URL`)

| Cột | Ý nghĩa |
|---|---|
| `ten` | Tên danh nhân/địa điểm |
| `link` | Link file Word (.docx) — nội dung bài viết |
| `anh1` .. `anh4` | Link ảnh minh họa (tối đa 4 ảnh, tự chèn xen kẽ vào bài) |

## 4. Cấu trúc thư mục

```
server.js            Toàn bộ route
sheets.js             Đọc Google Sheet tài liệu chính
newsFinder.js         Tìm bài mới nhất (RSS/sitemap) + ảnh (OG-tag/JSON-LD)
youtube.js            Video mới nhất từ kênh Youtube (RSS feed chính thức)
tts.js                Gọi TTS + cache audio ra đĩa (thư mục audio-cache/, tự sinh)
firebase.js           Khởi tạo Firestore từ .env
adminAuth.js          Kiểm tra mật khẩu khu quản lý
docReader.js          Đọc file Word bằng mammoth, chèn ảnh xen kẽ
nhanvat.js            Module Danh nhân & Địa điểm
fallback-images.js    Ảnh dự phòng khi không lấy được ảnh nguồn tin
phonemes.js           (giữ nguyên bản gốc — không đổi)
viet-normalizer.js    (giữ nguyên bản gốc — không đổi)
Viet39K.txt           Từ điển chuẩn hoá tiếng Việt (giữ nguyên)

views/
  home.ejs             Trang chủ
  category.ejs          Danh mục tài liệu theo loại
  reader.ejs            Đọc tài liệu (Word/PDF cuộn dọc, Youtube nhúng)
  mindmap.ejs            Sơ đồ tư duy tóm tắt
  nhanvat-list.ejs        Danh sách Danh nhân & Địa điểm
  nhanvat-article.ejs     Đọc 1 bài Danh nhân & Địa điểm
  youtube-embed.ejs       Nhúng video khi tài liệu là link Youtube
  admin-gate.ejs          Nhập mật khẩu khu quản lý
  admin-dashboard.ejs     Thống kê lượt truy cập

public/
  style.css             Toàn bộ giao diện + dark mode
  main.js               Dark mode, carousel, TTS player, chế độ nghe di chuyển
  images/fallback/       Ảnh dự phòng bạn tự thêm (không commit — xem .gitignore)
```

## 5. Ghi chú vận hành

- **Cache audio TTS** tự sinh ra ở `audio-cache/`, hoàn toàn tự động theo nội
  dung (đổi văn bản → tự tạo cache mới), không cần thao tác thủ công.
- **Không cần đăng nhập** để xem/nghe/tải bất kỳ nội dung nào. Khu quản lý
  (`/quanly`) là khu vực riêng, tách biệt, chỉ Ban Xây dựng Đảng dùng.
- Ảnh trong `public/images/fallback/` không đẩy lên GitHub — tự chuẩn bị trên
  server đang chạy (xem `.gitignore`).
