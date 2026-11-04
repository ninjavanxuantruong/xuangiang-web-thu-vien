import crypto from "crypto";

// =====================================================================
// Chống giả mạo yêu cầu (CSRF) kiểu "double-submit cookie":
//   1. Mỗi trình duyệt được cấp 1 mã ngẫu nhiên, lưu trong cookie riêng
//      (KHÔNG dùng session — tránh tạo session cho mọi khách ẩn danh vào
//      xem trang, vốn sẽ làm phình bộ nhớ MemoryStore theo thời gian).
//   2. Mỗi form POST nhúng đúng mã đó vào 1 ô ẩn "_csrf".
//   3. Khi submit, server so khớp cookie với ô ẩn — khớp thì mới xử lý.
// Trang khác (không cùng domain) không đọc/đặt được cookie của bạn nên
// không thể tự tạo mã đúng để giả mạo được.
// Không cần cài thêm thư viện — tự đọc header Cookie bằng tay.
// =====================================================================

const COOKIE_NAME = "csrfToken";
const COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 giờ là đủ cho 1 lượt ghé thăm

function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i === -1) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  });
  return out;
}

function isHttps(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

/**
 * Gắn sớm bằng app.use(csrfCookie) — TRƯỚC mọi route render form.
 * Đảm bảo mỗi trình duyệt có sẵn 1 mã CSRF, và đưa mã đó vào
 * res.locals.csrfToken để mọi view EJS đều dùng được biến csrfToken mà
 * không cần route nào tự truyền.
 */
export function csrfCookie(req, res, next) {
  const cookies = parseCookieHeader(req.headers.cookie);
  let token = cookies[COOKIE_NAME];

  if (!token || !/^[a-f0-9]{48}$/.test(token)) {
    token = crypto.randomBytes(24).toString("hex");
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps(req),
      maxAge: COOKIE_MAX_AGE_MS
    });
  }

  req.csrfToken = token;
  res.locals.csrfToken = token;
  next();
}

/**
 * Gắn vào TỪNG route POST/PUT/DELETE cần bảo vệ:
 *   app.post("/gop-y", csrfCheck, async (req, res) => {...});
 * Form tương ứng phải có:
 *   <input type="hidden" name="_csrf" value="<%= csrfToken %>" />
 */
export function csrfCheck(req, res, next) {
  const sent = req.body && req.body._csrf;
  const cookieToken = req.csrfToken;

  if (!cookieToken || !sent || sent !== cookieToken) {
    return res
      .status(403)
      .send("Phiên làm việc đã hết hạn hoặc yêu cầu không hợp lệ. Vui lòng tải lại trang rồi thử lại.");
  }
  next();
}
