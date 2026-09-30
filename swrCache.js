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
// Cách dùng:
//   const cache = createSwrCache({
//     name: "youtube.js",
//     ttlMs: 15 * 60 * 1000,
//     load: async () => [...],          // hàm lấy dữ liệu MỚI (được phép ném lỗi)
//     fallback: [],                     // giá trị trả về nếu lần đầu tiên đã lỗi
//     isEmpty: (v) => !v || v.length === 0
//   });
//   export function getX() { return cache.get(); }

export function createSwrCache({ name, ttlMs, load, fallback = null, isEmpty = null, retryMs = 60 * 1000 }) {
  let value;
  let hasValue = false;
  let loadedAt = 0;
  let refreshing = null;

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
          if (empty) expireSoon(); // rỗng ngay lần đầu -> đừng cache cả chu kỳ dài
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

  return {
    async get() {
      if (hasValue) {
        if (Date.now() - loadedAt >= ttlMs) refresh(); // làm mới ở nền, không chờ
        return value;
      }
      return refresh(); // chưa có gì: lần đầu tiên phải chờ
    },
    /** Xoá bản đang giữ để lần get() sau lấy lại từ đầu. */
    clear() {
      hasValue = false;
      value = undefined;
      loadedAt = 0;
    }
  };
}