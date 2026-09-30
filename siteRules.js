// Công thức riêng cho từng domain — dùng khi bộ quét chung (newsFinder.js)
// không xử lý đủ tin cậy (giao diện quá đặc thù, hoặc có bẫy như link
// không có href thật). Mỗi domain là 1 hàm nhận ($, siteUrl) — $ là HTML
// trang chủ đã load sẵn bằng cheerio — trả về { title, link } của bài mới
// nhất, hoặc null nếu không khớp được (site đổi giao diện...).
//
// QUAN TRỌNG: khi 1 domain có mặt ở đây, newsFinder.js CHỈ dùng đúng luật
// này — không thử RSS hay bộ quét chung nữa cho domain đó (tránh lấy nhầm
// bài không mong muốn từ 1 site đã biết là khó đoán).
//
// THÊM NGUỒN MỚI: cứ để trống trước — hầu hết nguồn sẽ tự chạy được qua
// RSS hoặc bộ quét chung. CHỈ thêm 1 dòng vào đây khi trang chủ hiện có
// (cờ found=false liên tục dù đã đợi vài lần tải) — lúc đó gửi lại HTML
// khối bài viết đầu tiên của trang đó để viết luật riêng.

function absolute(href, siteUrl) {
  if (!href) return null;
  try {
    return new URL(href, siteUrl).href;
  } catch {
    return null;
  }
}

function textOf($el) {
  return ($el.text() || "").trim();
}

export const SITE_RULES = {
  // dangcongsan.vn — dùng LINK GỐC (dangcongsan.vn/), khác cấu trúc trang
  // /tin-hoat-dong cũ. Bài đầu tiên nằm trong khối "Tin nổi bật" bên phải
  // (.right-news-hight12), mỗi bài là 1 ".items-news a".
  "dangcongsan.vn": ($, siteUrl) => {
    const $link = $(".right-news-hight12 .items-news a[href]").first();
    const href = $link.attr("href");
    const title = $link.attr("title") || textOf($link);
    if (!href || !title) return null;
    return { title, link: absolute(href, siteUrl) };
  },

  // qdnd.vn — tin đầu tiên trong khối "NỔI BẬT" (.hotnews-block .hotnews).
  "qdnd.vn": ($, siteUrl) => {
    const $link = $(".hotnews-block .hotnews article.item").first().find("a[href]").first();
    const href = $link.attr("href");
    const title = $link.attr("title") || textOf($link);
    if (!href || !title) return null;
    return { title, link: absolute(href, siteUrl) };
  },

  // tapchicongsan.org.vn — dùng link gốc (trang chủ). Bài nổi bật nằm
  // trong khối có class riêng ".titleHotNews" (ban đầu dùng
  // ".p0.mt15.bdr-bottom" nhưng đó chỉ là class tiện ích Bootstrap chung
  // chung, dễ trùng với các khối khác trên trang đầy đủ -> bắt nhầm).
  "tapchicongsan.org.vn": ($, siteUrl) => {
    const $link = $(".titleHotNews a[href]").first();
    const href = $link.attr("href");
    const title = textOf($link);
    if (!href || !title) return null;
    return { title, link: absolute(href, siteUrl) };
  },

  // vnanet.vn — khối "Tin mới nhất" bên trái có link KHÔNG có href thật
  // (<a class="buyTopNews"> không thuộc tính href, chắc phải trả phí mới
  // xem full) — LUÔN lấy ở khối "col-big-news" (tin ảnh lớn) thay vào đó.
  "vnanet.vn": ($, siteUrl) => {
    const $block = $(".col-big-news").first();
    if ($block.length === 0) return null;
    const $link = $block.find(".title-big-news a[href]").first();
    const href = $link.attr("href");
    const title = textOf($link);
    if (!href || !title) return null;
    return { title, link: absolute(href, siteUrl) };
  },

  // tuyengiaodanvan.vn — dùng link gốc (/vn). Trang dùng CSS "order-1"/
  // "order-2" để ĐẢO VỊ TRÍ HIỂN THỊ so với thứ tự thật trong HTML: bài
  // nổi bật (có ảnh) nằm ở CỘT THỨ HAI trong mã nguồn, còn cột "danh sách
  // nhỏ không ảnh" lại đứng trước nó trong HTML -> $("article").first()
  // bắt nhầm đúng bài đầu của danh sách nhỏ (không có ".blog-image" bên
  // trong) -> rỗng. Nhắm thẳng vào ".blog-image a[href]" thay vì đi qua
  // <article> đầu tiên — chỉ bài nổi bật mới có ảnh, danh sách nhỏ thì
  // không, nên không bị ảnh hưởng bởi thứ tự HTML/CSS order nữa. Tiêu đề
  // nằm ở thẻ <h3 href="..."> cùng khối cha <article> (href ở h3 chỉ là
  // thuộc tính trang trí cho React/CSS, KHÔNG phải link bấm được).
  "tuyengiaodanvan.vn": ($, siteUrl) => {
    const $link = $(".blog-image a[href]").first();
    const href = $link.attr("href");
    const title = textOf($link.closest("article").find("h3").first());
    if (!href || !title) return null;
    return { title, link: absolute(href, siteUrl) };
  }
};

/**
 * Tìm luật riêng khớp với 1 nguồn theo domain (bỏ "www."). Trả về hàm trích
 * xuất nếu có, null nếu domain này chưa có luật riêng (sẽ dùng bộ quét chung).
 */
export function findSiteRule(siteUrl) {
  try {
    const host = new URL(siteUrl).hostname.replace(/^www\./, "");
    return SITE_RULES[host] || null;
  } catch {
    return null;
  }
}