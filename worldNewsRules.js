// worldNewsRules.js
// Luật riêng cho từng domain dùng cho phần "Việt Nam trong cái nhìn thế
// giới" — KHÁC với siteRules.js: siteRules.js chỉ tìm 1 bài MỚI NHẤT trên
// trang chủ; ở đây cần quét ra một DANH SÁCH nhiều bài từ trang tìm kiếm/
// chuyên mục "vietnam" của từng báo (link do bạn dán trong Google Sheet),
// để worldNews.js còn lọc tiếp theo tiêu đề trước khi gọi AI.
//
// Mỗi rule là hàm ($, pageUrl) trả về mảng { title, link, image, dateMs,
// summary } theo đúng thứ tự xuất hiện trên trang — hoặc mảng rỗng nếu
// không khớp được cấu trúc (site đã đổi giao diện, cần cập nhật lại rule).
//
// THÊM NGUỒN MỚI: gửi outerHTML khối kết quả tìm kiếm của trang đó, viết
// thêm 1 rule vào WORLD_NEWS_RULES bên dưới.

function absolute(href, pageUrl) {
  if (!href) return null;
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return null;
  }
}

function textOf($el) {
  return ($el.text() || "").trim();
}

// KBS World ghi ngày kiểu "Write: 2026-09-22 14:25:31 / Update: ..."
// (mục Tin tức) hoặc chỉ "2026-09-11" (mục Nội dung) — lấy YYYY-MM-DD
// đầu tiên tìm thấy trong chuỗi, không phân biệt 2 định dạng.
function parseKbsDate(raw) {
  const m = String(raw || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`);
  return Number.isNaN(ms) ? null : ms;
}

export const WORLD_NEWS_RULES = {
  // world.kbs.co.kr — mỗi kết quả nằm trong 1 thẻ <article>, tiêu đề/ảnh/
  // ngày/tóm tắt ngắn đều có sẵn trong HTML tĩnh (không cần chạy JS).
  "world.kbs.co.kr": ($, pageUrl) => {
    const items = [];
    $("section.section_wrap article").each((_, el) => {
      const $article = $(el);
      const title = textOf($article.find(".list_link_area h2").first());
      const href = $article.find(".list_link_area > a").first().attr("href");
      const link = absolute(href, pageUrl);
      const image = $article.find(".thumb img").first().attr("src") || null;
      const dateMs = parseKbsDate($article.find(".date").first().text());
      const summary = textOf($article.find(".sum").first());
      if (title && link) items.push({ title, link, image, dateMs, summary });
    });
    return items;
  },

  // apnews.com — mỗi kết quả là 1 khối .PagePromo trong .PageList-items;
  // ngày nằm sẵn ở thuộc tính data-posted-date-timestamp (epoch mili-giây).
  "apnews.com": ($, pageUrl) => {
    const items = [];
    $(".PageList-items-item .PagePromo").each((_, el) => {
      const $promo = $(el);
      const $titleLink = $promo.find(".PagePromo-title a").first();
      const title = textOf($titleLink);
      const href = $titleLink.attr("href");
      const link = absolute(href, pageUrl);
      const image = $promo.find(".PagePromo-media img.Image").first().attr("src") || null;
      const tsRaw = $promo.attr("data-posted-date-timestamp");
      const dateMs = tsRaw && Number.isFinite(Number(tsRaw)) ? Number(tsRaw) : null;
      const summary = textOf($promo.find(".PagePromo-description a span").first());
      if (title && link) items.push({ title, link, image, dateMs, summary });
    });
    return items;
  }
};

/**
 * Tìm rule theo domain của link (khớp cả domain con, ví dụ world.kbs.co.kr
 * khớp luôn nếu link là something.world.kbs.co.kr).
 */
export function findWorldNewsRule(pageUrl) {
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, "");
    for (const domain of Object.keys(WORLD_NEWS_RULES)) {
      if (host === domain || host.endsWith("." + domain)) return WORLD_NEWS_RULES[domain];
    }
  } catch {
    // link không hợp lệ -> bỏ qua
  }
  return null;
}
