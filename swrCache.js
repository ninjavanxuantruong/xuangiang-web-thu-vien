// swrCache.js
// Bộ nhớ đệm trong RAM kiểu "trả bản cũ ngay, làm mới ở nền" (stale-while-revalidate),
// dùng chung cho các khối dữ liệu của trang chủ (video, tin xã, video kênh...).
//
// Khác cách cũ ("hết hạn thì NGƯỜI XEM kế tiếp phải chờ lấy lại"):
//   - Còn hạn                      -> trả ngay.
//   - Hết hạn nhưng đã có bản cũ   -> VẪN TRẢ NGAY bản cũ, đồng thời làm mới ở nền.
//                                     Người xem không bao giờ phải chờ (trừ lần đầu
//                                     tiên sau khi server khởi động).
//   - Nhiều người cùng thấy hết hạn -> chỉ có MỘT lượt làm mới chạy, không dồn dập.
//   - Làm mới LỖI hoặc ra RỖNG      -> giữ nguyên bản cũ còn tốt (không xoá trắng
//                                     khối tin), và thử lại sau retryMs (mặc định
//                                     1 phút) thay vì chờ trọn một chu kỳ ttlMs.
//
// MỚI THÊM — lưu dự phòng lên Firestore (tuỳ chọn, truyền persistKey):
//   Trước đây RAM trống sau mỗi lần khởi động lại (deploy, Render tự khởi
//   động lại...) nên NGƯỜI ĐẦU TIÊN vào lúc đó luôn phải chờ lấy dữ liệu
//   thật từ đầu (vài giây). Giờ mỗi lần làm mới THÀNH CÔNG, kèm ghi 1 bản
//   sao nhẹ lên Firestore. Khi RAM trống (vừa khởi động), get() thử đọc
//   bản sao đó trước — có thì trả ngay dù cũ vài chục phút, còn hơn bắt
//   người xem chờ; không có/đọc lỗi thì mới rơi về cách cũ (chờ lấy thật).
//   Chu kỳ làm mới (ttlMs) GIỮ NGUYÊN như trước, không đổi thành "1 lần/
//   ngày" kiểu firestoreCache.js — vẫn làm mới đều theo ttlMs như cũ, chỉ
//   thêm một tấm đệm cho đúng khoảnh khắc mới khởi động.
//
// Cách dùng (persistKey là tuỳ chọn — không truyền thì chạy y hệt bản cũ):
//   const cache = createSwrCache({
//     name: "youtube.js",
//     ttlMs: 15 * 60 * 1000,
//     load: async () => [...],          // hàm lấy dữ liệu MỚI (được phép ném lỗi)
//     fallback: [],                     // giá trị trả về nếu lần đầu tiên đã lỗi
//     isEmpty: (v) => !v || v.length === 0,
//     persistKey: "youtube-latest"      // tên riêng, không trùng cache khác
//   });
//   export function getX() { return cache.get(); }

import { firestore } from "./firebase.js";

const PERSIST_COLLECTION = "swr-persist";

// Firestore không nhận field "undefined" -> đi qua JSON để làm sạch, đồng
// thời nhân tiện lấy được 1 bản sao độc lập (sửa bản trả ra không ảnh
// hưởng bản đang lưu).
function sanitizeForFirestore(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

async function readPersisted(persistKey) {
  const snap = await firestore.collection(PERSIST_COLLECTION).doc(persistKey).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || !("value" in data)) return null;
  return { value: data.value, savedAt: data.savedAt ? new Date(data.savedAt).getTime() : Date.now() };
}

function writePersisted(persistKey, value) {
  firestore
    .collection(PERSIST_COLLECTION)
    .doc(persistKey)
    .set({ value: sanitizeForFirestore(value), savedAt: new Date().toISOString() })
    .catch((err) => console.warn(`swrCache: ghi dự phòng Firestore lỗi (${persistKey}):`, err.message));
}

export function createSwrCache({
  name,
  ttlMs,
  load,
  fallback = null,
  isEmpty = null,
  retryMs = 60 * 1000,
  persistKey = null
}) {
  let value;
  let hasValue = false;
  let loadedAt = 0;
  let refreshing = null;
  let restoring = null; // gộp các lượt cùng đọc Firestore lúc RAM còn trống

  // Đánh dấu để sau retryMs sẽ được coi là hết hạn và thử lại.
  function expireSoon() {
    loadedAt = Date.now() - ttlMs + Math.min(retryMs, ttlMs);
  }

  function refresh() {
    if (refreshing) return refreshing;

    refreshing = (async () => {
      try {
        const fresh = await load();
        const empty = isEmpty ? isEmpty(fresh) : false;

        if (empty && hasValue && !(isEmpty && isEmpty(value))) {
          // Kết quả mới rỗng (thường do lỗi mạng bị nuốt ở bên trong) mà đang có
          // bản tốt -> giữ bản tốt, chưa thay.
          console.warn(`${name}: lần làm mới trả rỗng, giữ dữ liệu cũ, sẽ thử lại sau ít phút`);
          expireSoon();
        } else {
          value = fresh;
          hasValue = true;
          loadedAt = Date.now();
          if (empty) {
            expireSoon(); // rỗng ngay lần đầu -> đừng cache cả chu kỳ dài
          } else if (persistKey) {
            writePersisted(persistKey, fresh); // không chờ, không làm chậm người đang xem
          }
        }
      } catch (err) {
        console.warn(`${name}: làm mới lỗi -`, err.message);
        if (!hasValue) {
          value = fallback;
          hasValue = true;
        }
        expireSoon();
      }
      return value;
    })().finally(() => {
      refreshing = null;
    });

    return refreshing;
  }

  // RAM đang trống (vừa khởi động): thử lấy bản dự phòng trên Firestore
  // trước khi đành phải chờ load() thật. Đọc lỗi/không có -> refresh() như cũ.
  function restoreThenServe() {
    if (restoring) return restoring;

    restoring = (async () => {
      try {
        const persisted = persistKey ? await readPersisted(persistKey) : null;
        if (persisted && !(isEmpty && isEmpty(persisted.value))) {
          value = persisted.value;
          hasValue = true;
          loadedAt = persisted.savedAt;
          if (Date.now() - loadedAt >= ttlMs) refresh(); // bản dự phòng đã cũ -> làm mới ở nền ngay
          return value;
        }
      } catch (err) {
        console.warn(`${name}: đọc dự phòng Firestore lỗi, chờ lấy dữ liệu thật -`, err.message);
      }
      return refresh(); // không có gì dùng tạm được -> như cũ, phải chờ
    })().finally(() => {
      restoring = null;
    });

    return restoring;
  }

  return {
    async get() {
      if (hasValue) {
        if (Date.now() - loadedAt >= ttlMs) refresh(); // làm mới ở nền, không chờ
        return value;
      }
      return restoreThenServe();
    },
    /** Xoá bản đang giữ để lần get() sau lấy lại từ đầu (RAM lẫn Firestore). */
    clear() {
      hasValue = false;
      value = undefined;
      loadedAt = 0;
      if (persistKey) {
        firestore
          .collection(PERSIST_COLLECTION)
          .doc(persistKey)
          .delete()
          .catch(() => {});
      }
    }
  };
}