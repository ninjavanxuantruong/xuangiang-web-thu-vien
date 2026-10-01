import admin from "firebase-admin";
import dotenv from "dotenv";

dotenv.config();

// Khởi tạo Firebase từ biến môi trường (.env) — KHÔNG hardcode private key
// trong code như bản cũ (bản cũ đã lộ key thật lên GitHub public, cần thu
// hồi key đó trên Firebase Console và tạo key mới trước khi dùng file này).
//
// Cần khai báo trong .env (không commit):
//   FIREBASE_PROJECT_ID=...
//   FIREBASE_CLIENT_EMAIL=...
//   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
//
// Lưu ý: khi dán private key vào .env, giữ nguyên trong 1 dòng, các ký tự
// xuống dòng biểu diễn dưới dạng \n — dòng .replace() bên dưới sẽ tự
// chuyển lại thành xuống dòng thật khi khởi tạo.

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

if (!projectId || !clientEmail || !privateKey) {
  console.error(
    "❌ Thiếu cấu hình Firebase trong .env — kiểm tra FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY"
  );
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey })
  });
}

export const firestore = admin.firestore();
export default admin;
