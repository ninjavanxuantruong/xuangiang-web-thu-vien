// Mật khẩu khu quản lý — đặt trong .env (ADMIN_PASSWORD), có giá trị mặc định
// đúng như đã thống nhất phòng khi bạn quên khai báo trong .env.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "26071994";

export function checkAdminPassword(password) {
  return typeof password === "string" && password === ADMIN_PASSWORD;
}

/**
 * Middleware bảo vệ các route trong khu quản lý (Ban XDĐ).
 * Nếu chưa nhập đúng mật khẩu trong phiên hiện tại -> đưa về trang nhập mật khẩu.
 */
export function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect("/quanly");
}
