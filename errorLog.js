// =====================================================================
// Giữ lại các lỗi gần đây trong bộ nhớ (RAM), để xem ở trang quản lý thay
// vì chỉ in ra console rồi mất khi server khởi động lại.
//
// Cách làm: bọc (wrap) console.error — MỌI console.error() đang có sẵn
// trong server.js và các file khác (29 chỗ hiện tại) đều tự động được ghi
// lại, KHÔNG cần sửa từng chỗ gọi console.error.
//
// QUAN TRỌNG: file này phải được import ĐẦU TIÊN trong server.js (trước
// mọi import khác), để bọc console.error trước khi bất kỳ module nào
// khác kịp lỗi trong lúc khởi động.
// =====================================================================

const MAX_ENTRIES = 200;
const entries = []; // cũ -> mới; getRecentErrors() sẽ đảo lại khi trả về

const originalError = console.error.bind(console);

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatArg(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === "string") return a;
  return safeStringify(a);
}

console.error = (...args) => {
  entries.push({
    time: new Date().toISOString(),
    message: args.map(formatArg).join(" ")
  });
  if (entries.length > MAX_ENTRIES) entries.shift();
  originalError(...args); // vẫn in ra console/log của Replit như cũ
};

/** Mới nhất trước. */
export function getRecentErrors() {
  return [...entries].reverse();
}

export function clearErrorLog() {
  entries.length = 0;
}
