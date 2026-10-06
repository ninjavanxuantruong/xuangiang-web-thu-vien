import axios from "axios";
import { createSwrCache } from "./swrCache.js";
import { getFallbackImage } from "./fallback-images.js";

// ====== LỊCH SỬ: TRƯỚC ĐÂY CÀO HTML TRANG XÃ, GIỜ CHUYỂN SANG FACEBOOK ======
// Đã xác nhận qua check-host.net: xuangiang.ninhbinh.gov.vn chặn theo "uy
// tín IP" — mọi IP dạng cloud/datacenter (Replit, Anthropic, Cloudflare...)
// đều bị chặn, kể cả IP dân dụng từ NHIỀU nước khác (Nhật, Indonesia,
// Ukraine đều qua được, chỉ IP hosting mới bị chặn). Vì đây là chặn ở tầng
// mạng/uy tín IP, không sửa được bằng code chạy trên server cloud như
// Replit. => Chuyển sang lấy tin từ chính fanpage Facebook của xã
// (facebook.com/xuangiangngaymoi) qua Graph API chính thức của Meta —
// không bị chặn kiểu này, và ổn định hơn scraping HTML rất nhiều.

const GRAPH_API_VERSION = "v21.0";
// Có thể để tên trang (username) hoặc Page ID số — Graph API nhận cả hai.
const FB_PAGE_ID = process.env.FB_PAGE_ID || "xuangiangngaymoi";
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || "";

const MAX_ITEMS = 10;
const MAX_ANH_MOI_TIN = 8; // giới hạn ảnh/bài để tránh payload quá nặng
const HTTP_TIMEOUT = 8000;

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 phút


function toProxiedImage(rawUrl) {
  if (!rawUrl) return null;
  return `/anh-ngoai?u=${encodeURIComponent(rawUrl)}`;
}

// Bài Facebook không có tiêu đề riêng như bài báo — lấy TRỌN câu đầu tiên
// của nội dung bài đăng làm tiêu đề hiển thị: ngắt ở dấu chấm câu (. ! ?)
// hoặc dấu xuống dòng, tùy cái nào xuất hiện trước, không cắt cụt theo số
// ký tự cố định (tránh vỡ nghĩa giữa câu).
function suyRaTieuDe(message) {
  if (!message) return "Xem bài viết trên Facebook xã Xuân Giang";

  const daCatXuongDong = message.split("\n").map((d) => d.trim()).find((d) => d.length > 0);
  const doanDau = (daCatXuongDong || message).trim();

  // Tìm dấu chấm câu đầu tiên (. ! ?) không tính các trường hợp viết tắt
  // phổ biến kiểu "TP.", "Q.", số thập phân... — chấp nhận đơn giản: chỉ
  // ngắt nếu sau dấu chấm là khoảng trắng + chữ hoa hoặc hết chuỗi, để
  // tránh cắt nhầm giữa số/viết tắt.
  const match = doanDau.match(/^(.{8,}?[.!?])(\s+[A-ZÀ-Ỹ]|\s*$)/u);
  const cauDau = match ? match[1].trim() : doanDau;

  // Chỉ cắt bớt nếu câu quá dài bất thường (ví dụ bài không có dấu chấm
  // câu nào trong cả đoạn dài), để không phá layout — nhưng vẫn giữ hết
  // câu, không thêm "…" giữa từ.
  const GIOI_HAN_KY_TU = 220;
  if (cauDau.length <= GIOI_HAN_KY_TU) return cauDau;
  const catOKhoangTrang = cauDau.slice(0, GIOI_HAN_KY_TU).lastIndexOf(" ");
  return cauDau.slice(0, catOKhoangTrang > 0 ? catOKhoangTrang : GIOI_HAN_KY_TU).trim() + "…";
}

// created_time của Graph API dạng "2026-09-10T08:15:00+0700" -> đổi về
// "dd/mm/yyyy" cho đồng bộ với định dạng ngày cũ site từng hiển thị.
function suyRaNgay(createdTime) {
  if (!createdTime) return null;
  const d = new Date(createdTime);
  if (Number.isNaN(d.getTime())) return null;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// Bài đăng nhiều ảnh (album) thì Graph API trả từng ảnh trong
// attachments.data[0].subattachments.data[]; bài chỉ 1 ảnh thì ảnh nằm
// thẳng ở attachments.data[0].media. Gộp lại thành 1 mảng URL ảnh gốc,
// bỏ trùng, giới hạn số lượng để tránh trang nặng.
function trichAnhBaiViet(post) {
  const attachments = post.attachments?.data || [];
  const urls = [];

  for (const att of attachments) {
    const subs = att.subattachments?.data;
    if (Array.isArray(subs) && subs.length > 0) {
      for (const sub of subs) {
        const src = sub.media?.image?.src;
        if (src) urls.push(src);
      }
    } else {
      const src = att.media?.image?.src;
      if (src) urls.push(src);
    }
  }

  const doiUrlBoTrung = [...new Set(urls)];
  if (doiUrlBoTrung.length > 0) return doiUrlBoTrung.slice(0, MAX_ANH_MOI_TIN);

  // Không có attachments (hiếm) -> dùng tạm full_picture nếu có.
  return post.full_picture ? [post.full_picture] : [];
}

async function fetchTinTuFacebook() {
  if (!FB_PAGE_ACCESS_TOKEN) {
    console.warn(
      "xaNews: thiếu biến môi trường FB_PAGE_ACCESS_TOKEN — chưa cấu hình lấy tin từ Facebook."
    );
    return [];
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${FB_PAGE_ID}/posts`;
  const resp = await axios.get(url, {
    timeout: HTTP_TIMEOUT,
    params: {
      fields:
        "message,full_picture,permalink_url,created_time,attachments{media_type,type,media,subattachments{media}}",
      limit: MAX_ITEMS,
      access_token: FB_PAGE_ACCESS_TOKEN
    }
  });

  const posts = Array.isArray(resp.data?.data) ? resp.data.data : [];

  return posts
    .filter((p) => p.permalink_url) // bỏ qua bài không có link (hiếm khi xảy ra)
    .map((p) => {
      const title = suyRaTieuDe(p.message);
      const anhGoc = trichAnhBaiViet(p);
      const images = anhGoc.map((u) => toProxiedImage(u)).filter(Boolean);
      const anhMacDinh = getFallbackImage(p.permalink_url, title);

      return {
        title,
        link: p.permalink_url,
        date: suyRaNgay(p.created_time),
        image: images[0] || anhMacDinh,
        // Toàn bộ ảnh của bài — dùng cho tin nổi bật (chạy slideshow qua
        // hết ảnh); các tin nhỏ trong danh sách chỉ cần dùng `image` (ảnh
        // đầu) là đủ.
        images: images.length > 0 ? images : [anhMacDinh]
      };
    });
}

async function loadXaNews() {
  try {
    return await fetchTinTuFacebook();
  } catch (err) {
    // Ném lỗi (kèm chi tiết từ Facebook) để swrCache GIỮ bản tin cũ, thay vì
    // xoá trắng khối tin xã trong 30 phút mỗi khi Facebook lỗi thoáng qua.
    throw new Error(err.response?.data?.error?.message || err.message);
  }
}

// Trả bản cũ ngay khi hết hạn và làm mới ở nền (xem swrCache.js).
const xaNewsCache = createSwrCache({
  name: "xaNews",
  ttlMs: CACHE_TTL_MS,
  load: loadXaNews,
  fallback: [],
  isEmpty: (v) => !v || v.length === 0,
  persistKey: "xa-news"
});

/**
 * Trả về danh sách tin nổi bật của xã (nguồn: fanpage Facebook).
 * Luôn trả mảng (rỗng nếu lỗi), không bao giờ ném lỗi ra route gọi nó.
 */
export function getXaNews() {
  return xaNewsCache.get();
}