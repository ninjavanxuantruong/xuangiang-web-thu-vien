import { fetchSheetRaw } from "./sheets.js";
import { interleaveImages } from "./docReader.js";
import { getWordParagraphsCached } from "./wordCache.js";
import { extractImagesFromPage } from "./newsFinder.js";

/**
 * Mục Danh nhân & Địa điểm dùng 1 Google Sheet RIÊNG (NHANVAT_SHEET_URL),
 * đọc THEO ĐÚNG VỊ TRÍ CỘT (không theo tên tiêu đề):
 *
 *   Cột A -> tên danh nhân/địa điểm
 *   Cột B -> thông tin (đoạn giới thiệu mở đầu bài viết)
 *   Cột C -> link văn bản Word (nội dung chính)
 *   Cột D -> ẢNH ĐẠI DIỆN: link chia sẻ file ảnh trên Google Drive, dạng
 *            https://drive.google.com/file/d/<ID>/view?usp=sharing
 *            (file phải để chế độ "Bất kỳ ai có đường liên kết")
 *   Cột E trở đi -> mỗi cột là 1 link bài viết/trang có ảnh về nhân vật đó
 *            (không giới hạn số cột). Hệ thống tự lấy ảnh trong trang, gộp
 *            thành kho ảnh, xáo ngẫu nhiên rồi chèn xen giữa các đoạn văn.
 *
 * Ảnh ở cột D cũng được đưa vào kho ảnh của bài viết.
 */

// Người nhập sheet thường quen copy link "Chia sẻ" của Google Docs, dạng
// .../document/d/<ID>/edit?usp=sharing... — link đó mở trình soạn thảo,
// KHÔNG trả về nội dung file thật nên docReader.js tải về sẽ lỗi. Tự động
// đổi sang link "export" (tải thẳng nội dung dạng .docx).
function chuanHoaLinkWord(url) {
  if (!url) return url;
  const match = url.match(/docs\.google\.com\/document\/d\/([^/]+)/);
  if (match && match[1]) {
    return `https://docs.google.com/document/d/${match[1]}/export?format=docx`;
  }
  return url;
}

// ====== Ảnh Google Drive ======

// Lấy ID file từ các dạng link Drive hay gặp:
//   https://drive.google.com/file/d/<ID>/view?usp=sharing
//   https://drive.google.com/open?id=<ID>
//   https://drive.google.com/uc?export=view&id=<ID>
// Trả về null nếu không phải link Drive.
function layIdDrive(url) {
  if (!url) return null;
  if (!/(?:drive|docs)\.google\.com/i.test(url)) return null;

  const byPath = url.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (byPath) return byPath[1];

  const byQuery = url.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (byQuery) return byQuery[1];

  return null;
}

// Đổi link Drive -> link ảnh thật (thumbnail độ phân giải cao, ổn định hơn
// uc?export=view), rồi cho đi qua proxy /anh-ngoai của server mình. Lý do
// qua proxy: nếu trình duyệt người xem tự tải thẳng từ Drive, Google hay
// chặn/giới hạn tần suất khi nhiều người xem -> ảnh vỡ. Qua proxy thì ảnh
// luôn tải từ chính domain của mình (proxy còn có sẵn ảnh SVG dự phòng nếu
// Drive tạm lỗi).
function linkDriveThanhAnh(fileId) {
  const direct = `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;
  return `/anh-ngoai?u=${encodeURIComponent(direct)}`;
}

// Cache cho trường hợp cột D KHÔNG phải link Drive (nhập kiểu cũ: link
// trang bài viết hoặc link ảnh trực tiếp) -> vẫn dò như trước để không hỏng
// dữ liệu cũ.
const CACHE_AVATAR_TTL_MS = 24 * 60 * 60 * 1000;
const cacheAvatar = new Map(); // link cột D -> { url, time }

async function layAnhDaiDien(linkCotD) {
  if (!linkCotD) return null;

  // 1) Chuẩn mới: link Drive -> không cần gọi mạng, chỉ đổi link.
  const driveId = layIdDrive(linkCotD);
  if (driveId) return linkDriveThanhAnh(driveId);

  // 2) Dự phòng kiểu cũ: link bất kỳ -> bóc ảnh đầu tiên trong trang.
  const cached = cacheAvatar.get(linkCotD);
  if (cached && Date.now() - cached.time < CACHE_AVATAR_TTL_MS) return cached.url;

  let url = null;
  try {
    const images = await extractImagesFromPage(linkCotD);
    url = images[0] || null;
  } catch {
    url = null;
  }

  cacheAvatar.set(linkCotD, { url, time: Date.now() });
  return url;
}

export async function getNhanVatList() {
  const url = process.env.NHANVAT_SHEET_URL;
  const rows = await fetchSheetRaw(url);

  const items = rows
    .map((row) => {
      const values = row.map((v) => (v == null ? "" : String(v).trim()));

      const name = values[0] || "Chưa đặt tên";
      const info = values[1] || "";
      const wordUrl = chuanHoaLinkWord(values[2] || "");

      // Cột D cố định là ảnh đại diện (KHÔNG lọc ô trống trước khi lấy, để
      // nếu D trống mà E có link thì E không bị "trượt" lên thành ảnh đại
      // diện). Từ cột E trở đi mới lọc bỏ ô trống.
      const avatarLink = values[3] || "";
      const imageLinks = values.slice(4).filter(Boolean);

      return { name, info, wordUrl, avatarLink, imageLinks };
    })
    .filter((item) => item.wordUrl);

  // Lấy ảnh đại diện song song cho tất cả.
  await Promise.all(
    items.map(async (item) => {
      const avatar = await layAnhDaiDien(item.avatarLink);
      item.images = avatar ? [avatar] : [];
    })
  );

  return items;
}

export async function getNhanVatByName(name) {
  const list = await getNhanVatList();
  return list.find((item) => item.name === name);
}

/**
 * Dựng bài viết hoàn chỉnh: đoạn "Thông tin" (nếu có) làm mở đầu, sau đó
 * nội dung file Word + ảnh (ảnh đại diện cột D + ảnh bóc từ các link cột E
 * trở đi), chèn ngẫu nhiên xen giữa các đoạn văn.
 */
export async function buildNhanVatArticle(name) {
  const item = await getNhanVatByName(name);
  if (!item) return null;

  const paragraphs = await getWordParagraphsCached(item.wordUrl);

  // Ảnh từ các link cột E+ (bóc trong trang), lấy song song.
  const imageArrays = await Promise.all(
    item.imageLinks.map((link) => extractImagesFromPage(link).catch(() => []))
  );

  // Ảnh đại diện cột D cũng cho vào kho ảnh của bài.
  const images = [...item.images, ...imageArrays.flat()];

  const blocks = interleaveImages(paragraphs, images);

  if (item.info) {
    blocks.unshift({ type: "text", content: `<strong>${item.info}</strong>` });
  }

  return { name: item.name, blocks };
}