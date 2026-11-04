// Ảnh dự phòng khi newsFinder.js không tự động lấy được ảnh thật nào từ 1
// nguồn tin (site chặn crawl, không có og:image, hết timeout...).
//
// Tự sinh 1 ảnh SVG (mã hoá base64 nhúng thẳng vào thuộc tính src, không
// phải file trên đĩa) — chữ cái đầu tên nguồn trên nền màu, màu được chọn
// ỔN ĐỊNH theo tên nguồn (cùng 1 nguồn luôn ra cùng 1 màu). Nhờ vậy KHÔNG
// còn phụ thuộc việc bạn phải tự tải ảnh .jpg lên public/images/fallback/
// — trước đây thư mục đó luôn trống trên server thật (đúng như comment cũ
// ghi "không cần đẩy lên GitHub"), nên mọi nguồn rơi vào nhánh này đều ra
// icon ảnh vỡ vì trỏ tới file không tồn tại. Cách này không bao giờ vỡ.

const PALETTE = [
  "#C0392B", "#D9781C", "#A8841C", "#1E8F5E", "#12857A",
  "#1F6FB2", "#34495E", "#6C3FA0", "#B23A6B"
];

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0; // ép về số nguyên 32-bit
  }
  return Math.abs(hash);
}

function colorForLabel(label) {
  return PALETTE[hashString(label) % PALETTE.length];
}

function escapeXml(str) {
  return String(str).replace(/[<>&"']/g, (ch) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;"
  }[ch]));
}

/**
 * Trả về data URI của 1 ảnh SVG dự phòng — chữ cái đầu tên nguồn trên nền
 * màu đặc trưng cho nguồn đó. Không cần mạng, không cần file, không bao
 * giờ lỗi.
 */
export function getFallbackImage(sourceLink, sourceName) {
  const svg = getFallbackSvgMarkup(sourceLink, sourceName);
  return "data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64");
}

function shadeColor(hex, percent) {
  const num = parseInt(hex.replace("#", ""), 16);
  const clamp = (v) => Math.min(255, Math.max(0, v));
  const r = clamp((num >> 16) + percent);
  const g = clamp(((num >> 8) & 0x00ff) + percent);
  const b = clamp((num & 0x0000ff) + percent);
  return "#" + (0x1000000 + r * 0x10000 + g * 0x100 + b).toString(16).slice(1);
}

/**
 * Mã SVG THÔ (không phải data URI) của ảnh dự phòng — dùng khi cần TRẢ VỀ
 * TRỰC TIẾP như 1 ảnh thật (Content-Type: image/svg+xml), ví dụ khi proxy
 * /anh-ngoai gọi ảnh ngoài bị lỗi: thay vì trả trang lỗi (khiến trình
 * duyệt hiện icon ảnh vỡ), trả luôn SVG này để người xem vẫn thấy 1 ảnh
 * đại diện đẹp, không bao giờ vỡ.
 */
export function getFallbackSvgMarkup(sourceLink, sourceName) {
  const label = (sourceName || sourceLink || "?").trim();
  const initial = [...label].find((ch) => /[\p{L}\p{N}]/u.test(ch)) || "?";
  const color = colorForLabel(label);
  const darker = shadeColor(color, -30);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="220">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${color}"/>` +
    `<stop offset="100%" stop-color="${darker}"/>` +
    `</linearGradient></defs>` +
    `<rect width="100%" height="100%" fill="url(#g)"/>` +
    `<text x="50%" y="54%" font-family="Arial, sans-serif" font-size="92" ` +
    `font-weight="700" fill="#ffffff" fill-opacity="0.92" text-anchor="middle" ` +
    `dominant-baseline="middle">${escapeXml(initial.toUpperCase())}</text>` +
    `</svg>`
  );
}