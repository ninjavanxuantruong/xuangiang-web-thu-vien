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
//     như CHƯA xong nên sau một khoảng nghỉ ngắn sẽ tự thử lại.
//
// BẢN NÀY THÊM (để chịu được đông người):
//   1) Lớp cache RAM ngắn (RAM_TTL_MS) đặt TRƯỚC Firestore: 200 người vào
//      cùng lúc chỉ tốn vài lượt đọc Firestore thay vì hàng trăm — tiết kiệm
//      hạn mức đọc miễn phí và nhanh hơn.
//   2) Các lượt đọc Firestore giống nhau đang chạy dở được gộp thành 1.
//   3) Không đọc được Firestore (mạng lỗi, hết hạn mức...) mà RAM còn bản cũ
//      -> dùng bản trong RAM, trang vẫn lên bình thường.
//   4) Ghi Firestore lỗi thì vẫn dùng dữ liệu vừa lấy được (trước đây bị bỏ
//      phí, phải lấy lại từ đầu).
//   5) Lấy dữ liệu mới thất bại/rỗng thì nghỉ RETRY_COOLDOWN_MS rồi mới thử
//      lại, thay vì mỗi người vào lại kích hoạt thử lại một lần.
//   6) Dữ liệu trả ra luôn là BẢN SAO, nơi gọi sửa thoải mái cũng không làm
//      hỏng bản đang giữ trong RAM.

import { firestore } from "./firebase.js";

const COLLECTION = "cache";
const DAY_START_HOUR = 5; // 5h sáng là mốc bắt đầu "ngày cache" mới
const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // giờ Việt Nam = UTC+7, tính cứng
// cho chắc vì server (Replit...) thường chạy giờ UTC, không phụ thuộc múi
// giờ hệ điều hành của máy chủ.

const RAM_TTL_MS = 2 * 60 * 1000; // giữ bản trong RAM tối đa 2 phút rồi hỏi lại Firestore
const RETRY_COOLDOWN_MS = 60 * 1000; // lấy dữ liệu mới lỗi/rỗng -> nghỉ 1 phút mới thử lại

// Chặn tình trạng nhiều người cùng bấm vào đúng lúc đầu ngày -> gọi
// fetchFn() (tốn API) trùng nhau nhiều lần. Chỉ cần giữ trong RAM của
// đúng tiến trình server đang chạy, không cần lưu Firestore.
const inFlight = new Map();
const readInFlight = new Map(); // key -> Promise đọc Firestore đang chạy dở
const ramCache = new Map(); // key -> { dayKey, data, time }
const cooldown = new Map(); // key -> { until, value }

function clone(data) {
  if (data == null) return data;
  try {
    return structuredClone(data);
  } catch {
    return data;
  }
}

function remember(key, dayKey, data) {
  ramCache.set(key, { dayKey, data: clone(data), time: Date.now() });
}

/**
 * Xoá bản đang giữ trong RAM (1 key, hoặc tất cả nếu không truyền key).
 * server.js gọi hàm này sau khi trang quản lý xoá cache trên Firestore, để
 * lần tải tiếp theo thật sự lấy lại từ đầu chứ không dùng bản cũ trong RAM.
 */
export function clearRamCache(key) {
  if (key) {
    ramCache.delete(key);
    cooldown.delete(key);
  } else {
    ramCache.clear();
    cooldown.clear();
  }
}

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

// Đọc 1 tài liệu cache từ Firestore; nhiều nơi gọi cùng lúc chỉ tốn 1 lượt đọc.
function readDoc(key) {
  if (readInFlight.has(key)) return readInFlight.get(key);
  const p = firestore
    .collection(COLLECTION)
    .doc(key)
    .get()
    .then((snap) => (snap.exists ? snap.data() : null))
    .finally(() => readInFlight.delete(key));
  readInFlight.set(key, p);
  return p;
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

  // 1) Bản trong RAM còn mới và đúng "ngày cache" hôm nay -> trả ngay.
  const ram = ramCache.get(key);
  if (ram && ram.dayKey === todayKey && Date.now() - ram.time < RAM_TTL_MS) {
    return clone(ram.data);
  }

  // 2) Hỏi Firestore.
  let old = null;
  let readFailed = false;
  try {
    old = await readDoc(key);
  } catch (err) {
    readFailed = true;
    console.error(`firestoreCache: đọc Firestore lỗi (key=${key}) -`, err.message);
  }

  // Firestore đang lỗi mà RAM còn bản cũ -> dùng tạm, đừng đi lấy lại từ đầu.
  if (readFailed && ram) return clone(ram.data);

<<<<<<< Updated upstream
<<<<<<< Updated upstream
  // Đã có đúng bản của "ngày cache" hôm nay -> chỉ đọc, không gọi fetchFn.
  if (old && old.dayKey === todayKey) {
=======
=======
>>>>>>> Stashed changes
  // Đã có đúng bản của "ngày cache" hôm nay VÀ bản đó không rỗng -> chỉ
  // đọc, không gọi fetchFn. Nếu bản hôm nay bị rỗng/thiếu (ví dụ bị xoá
  // tay trong Firebase, hoặc xoá qua khu quản lý nhưng dayKey chưa kịp
  // đổi) -> coi như CHƯA CÓ, đi lấy mới ngay — đúng ý "khối nào trống thì
  // người đầu tiên vào phải lấy lại khối đó".
  if (old && old.dayKey === todayKey && !isEmpty(old.data)) {
<<<<<<< Updated upstream
>>>>>>> Stashed changes
=======
>>>>>>> Stashed changes
    remember(key, todayKey, old.data);
    return clone(old.data);
  }

  // Vừa lấy mới thất bại cách đây chưa lâu -> chưa thử lại vội.
  const cd = cooldown.get(key);
  if (cd && cd.until > Date.now()) return clone(cd.value);

  // Đã có người khác (trong cùng tiến trình server) đang làm mới đúng key
  // này rồi -> chờ chung kết quả, khỏi gọi API/AI 2 lần cùng lúc.
  if (inFlight.has(key)) return clone(await inFlight.get(key));

  const docRef = firestore.collection(COLLECTION).doc(key);

  const task = (async () => {
    try {
      const fresh = await fetchFn();
      if (isEmpty(fresh)) {
        console.warn(`firestoreCache: fetchFn trả rỗng (key=${key}), giữ dữ liệu cũ, sẽ tự thử lại sau ít phút`);
        const value = old ? old.data : fresh;
        cooldown.set(key, { until: Date.now() + RETRY_COOLDOWN_MS, value });
        return value;
      }

      cooldown.delete(key);
      remember(key, todayKey, fresh); // dùng được ngay, kể cả khi ghi Firestore bên dưới lỗi
      try {
        await docRef.set({ dayKey: todayKey, data: fresh, updatedAt: new Date().toISOString() });
      } catch (err) {
        console.error(`firestoreCache: ghi Firestore lỗi (key=${key}) -`, err.message);
      }
      return fresh;
    } catch (err) {
      console.error(`firestoreCache: fetchFn lỗi (key=${key}) -`, err.message);
      const value = old ? old.data : (Array.isArray(old?.data) ? [] : null);
      cooldown.set(key, { until: Date.now() + RETRY_COOLDOWN_MS, value });
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, task);
  return clone(await task);
}

/**
 * Đọc dữ liệu ĐANG có trên Firestore cho 1 key, KHÔNG quan tâm còn hạn hay
 * không, KHÔNG gọi fetchFn. Dùng khi cần "bài cũ để dự phòng" cho từng
 * phần nhỏ bên trong 1 lần refresh (vd worldNews.js: 1 nguồn báo lỗi thì
 * lấy đỡ bài cũ CỦA ĐÚNG NGUỒN ĐÓ từ bản hôm qua).
 * Đọc Firestore lỗi thì lấy tạm bản trong RAM (nếu có).
 */
export async function peek(key) {
  try {
    const old = await readDoc(key);
    return old ? clone(old.data) : null;
  } catch (err) {
    console.error(`firestoreCache: peek lỗi (key=${key}) -`, err.message);
    const ram = ramCache.get(key);
    return ram ? clone(ram.data) : null;
  }
}