// firestoreCache.js
// Cache DÙNG CHUNG cho mọi người xem, lưu trên Firestore — tự làm mới
// ĐÚNG 1 LẦN/NGÀY, tính mốc "ngày" từ 5h sáng (giờ Việt Nam), KHÔNG phải
// 0h. Đúng ý đã thống nhất:
//   - Người ĐẦU TIÊN vào sau 5h sáng mỗi ngày -> chưa có bản của "ngày cache"
//     hôm nay -> người đó (thực ra là request của họ) sẽ kích hoạt lấy dữ
//     liệu mới (fetchFn), rồi GHI ĐÈ lên Firestore.
//   - Mọi người vào SAU đó trong cùng ngày -> Firestore đã có đúng bản hôm
//     nay -> chỉ đọc lại, không gọi fetchFn (không tốn API bên ngoài nữa).
//   - Nếu lấy dữ liệu mới bị lỗi/rỗng -> KHÔNG ghi đè, giữ nguyên bản cũ
//     (dù của hôm qua) để trang không bao giờ trống trơn; "ngày cache" coi
//     như CHƯA xong nên lượt xem kế tiếp sẽ tự thử lại giúp mình.

import { firestore } from "./firebase.js";

const COLLECTION = "cache";
const DAY_START_HOUR = 5; // 5h sáng là mốc bắt đầu "ngày cache" mới
const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // giờ Việt Nam = UTC+7, tính cứng
// cho chắc vì server (Replit...) thường chạy giờ UTC, không phụ thuộc múi
// giờ hệ điều hành của máy chủ.

// Chặn tình trạng nhiều người cùng bấm vào đúng lúc đầu ngày -> gọi
// fetchFn() (tốn API) trùng nhau nhiều lần. Chỉ cần giữ trong RAM của
// đúng tiến trình server đang chạy, không cần lưu Firestore.
const inFlight = new Map();

// Tính "ngày cache" hiện tại theo giờ Việt Nam, mốc bắt đầu 5h sáng.
// Ví dụ 24/9 04:59 (giờ VN) -> vẫn tính là ngày cache "23/9".
function getDayKey(now = new Date()) {
  const vn = new Date(now.getTime() + VN_OFFSET_MS);
  const key = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()));
  if (vn.getUTCHours() < DAY_START_HOUR) key.setUTCDate(key.getUTCDate() - 1);
  return key.toISOString().split("T")[0]; // "YYYY-MM-DD"
}

function macDinhRong(data) {
  return data == null || (Array.isArray(data) && data.length === 0);
}

/**
 * key: định danh cache, vd "youtube-latest", "xa-news", "the-gioi",
 *      "bai-doc-de-xuat" — mỗi khối dữ liệu 1 key riêng.
 * fetchFn: async () => dữ liệu mới nhất (mảng/obj tuỳ khối).
 * options.isEmpty(data): hàm tự định nghĩa thế nào là "rỗng/coi như lỗi,
 *      đừng ghi đè" — mặc định coi null/undefined/mảng rỗng là rỗng.
 */
export async function getOrRefresh(key, fetchFn, options = {}) {
  const isEmpty = options.isEmpty || macDinhRong;
  const todayKey = getDayKey();
  const docRef = firestore.collection(COLLECTION).doc(key);

  let old = null;
  try {
    const snap = await docRef.get();
    if (snap.exists) old = snap.data();
  } catch (err) {
    console.error(`firestoreCache: đọc Firestore lỗi (key=${key}) -`, err.message);
  }

  // Đã có đúng bản của "ngày cache" hôm nay -> chỉ đọc, không gọi fetchFn.
  if (old && old.dayKey === todayKey) {
    return old.data;
  }

  // Đã có người khác (trong cùng tiến trình server) đang làm mới đúng key
  // này rồi -> chờ chung kết quả, khỏi gọi API/AI 2 lần cùng lúc.
  if (inFlight.has(key)) return inFlight.get(key);

  const task = (async () => {
    try {
      const fresh = await fetchFn();
      if (isEmpty(fresh)) {
        console.warn(`firestoreCache: fetchFn trả rỗng (key=${key}), giữ dữ liệu cũ, để lượt sau tự thử lại`);
        return old ? old.data : fresh;
      }
      await docRef.set({ dayKey: todayKey, data: fresh, updatedAt: new Date().toISOString() });
      return fresh;
    } catch (err) {
      console.error(`firestoreCache: fetchFn lỗi (key=${key}) -`, err.message);
      return old ? old.data : (Array.isArray(old?.data) ? [] : null);
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return task;
}

/**
 * Đọc dữ liệu ĐANG có trên Firestore cho 1 key, KHÔNG quan tâm còn hạn hay
 * không, KHÔNG gọi fetchFn. Dùng khi cần "bài cũ để dự phòng" cho từng
 * phần nhỏ bên trong 1 lần refresh (vd worldNews.js: 1 nguồn báo lỗi thì
 * lấy đỡ bài cũ CỦA ĐÚNG NGUỒN ĐÓ từ bản hôm qua).
 */
export async function peek(key) {
  try {
    const snap = await firestore.collection(COLLECTION).doc(key).get();
    return snap.exists ? snap.data().data : null;
  } catch (err) {
    console.error(`firestoreCache: peek lỗi (key=${key}) -`, err.message);
    return null;
  }
}