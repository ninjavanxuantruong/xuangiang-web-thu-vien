import crypto from "crypto";

// Mật khẩu khu quản lý — CHỈ lấy từ biến môi trường ADMIN_PASSWORD
// (Replit: Secrets; Render: Environment). KHÔNG có mật khẩu mặc định ghi
// cứng trong code nữa. Nếu quên khai báo thì khu quản lý từ chối mọi lần
// đăng nhập (an toàn) thay vì để lộ mật khẩu mặc định.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
if (!ADMIN_PASSWORD) {
  console.warn("adminAuth: chưa đặt biến môi trường ADMIN_PASSWORD — khu quản lý sẽ từ chối mọi lần đăng nhập.");
}

// Băm 2 phía về cùng độ dài rồi so sánh kiểu "thời gian không đổi", tránh
// lộ thông tin qua độ trễ khi so sánh chuỗi.
function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

export function checkAdminPassword(password) {
  if (!ADMIN_PASSWORD) return false;
  if (typeof password !== "string") return false;
  return crypto.timingSafeEqual(sha256(password), sha256(ADMIN_PASSWORD));
}

/**
 * Middleware bảo vệ các route trong khu quản lý (Ban XDĐ).
 * Nếu chưa nhập đúng mật khẩu trong phiên hiện tại -> đưa về trang nhập mật khẩu.
 */
export function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/quanly");
}