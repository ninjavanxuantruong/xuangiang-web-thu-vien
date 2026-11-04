// =========================================================
// public/rotator.js
// Dùng cho các khối danh sách đầy đủ (đã render hết trong HTML) nhưng chỉ
// muốn hiện 1 "cửa sổ" N mục tại 1 thời điểm, tự động quay vòng sau vài
// giây — ví dụ "Bài đọc đề xuất", "Video mới nhất từ các kênh".
//
// Cách dùng: bọc container (đã có sẵn toàn bộ thẻ .card con) bằng các
// data-attribute sau:
//   data-rotator                    bắt buộc, đánh dấu container cần quay vòng
//   data-rotator-count="2"          số mục hiện cùng lúc trên MOBILE (mặc định 2)
//   data-rotator-count-desktop="4"  số mục hiện cùng lúc trên PC (bỏ trống thì
//                                   dùng luôn số của mobile, không đổi hành vi cũ)
//   data-rotator-interval="4500"    số mili-giây giữa mỗi lần chuyển (mặc định 4500)
//   data-rotator-reverse="true"     quay theo chiều ngược lại (mặc định false)
//
// Mốc phân biệt mobile/PC dùng đúng breakpoint 720px đã có sẵn trong
// style.css (max-width: 720px = mobile) để đồng bộ với giao diện.
//
// Không cần sửa gì trong server.js — hoạt động hoàn toàn ở trình duyệt,
// dựa trên danh sách đã có sẵn trong HTML.
// =========================================================

(function () {
  const DESKTOP_QUERY = "(min-width: 721px)";

  function initRotator(container) {
    const items = Array.from(container.children);
    const mobileCount = parseInt(container.getAttribute("data-rotator-count") || "2", 10);
    const desktopAttr = container.getAttribute("data-rotator-count-desktop");
    const desktopCount = desktopAttr ? parseInt(desktopAttr, 10) : mobileCount;
    const interval = parseInt(container.getAttribute("data-rotator-interval") || "4500", 10);
    const reverse = container.getAttribute("data-rotator-reverse") === "true";

    const mql = window.matchMedia(DESKTOP_QUERY);
    let visibleCount = mql.matches ? desktopCount : mobileCount;

    let start = 0;

    function render() {
      if (items.length <= visibleCount) {
        items.forEach((el) => (el.style.display = ""));
        return;
      }
      items.forEach((el, i) => {
        const offset = ((i - start) % items.length + items.length) % items.length;
        el.style.display = offset < visibleCount ? "" : "none";
      });
    }

    render();

    let timer = null;
    function startTimer() {
      if (items.length <= visibleCount) return; // đủ ít thì hiện hết, không cần quay
      timer = setInterval(() => {
        start = reverse
          ? (start - 1 + items.length) % items.length
          : (start + 1) % items.length;
        render();
      }, interval);
    }
    startTimer();

    // Đổi cỡ màn hình (xoay ngang/dọc, thu/giãn cửa sổ trình duyệt) -> đổi
    // lại số mục hiện cùng lúc ngay, không cần tải lại trang.
    mql.addEventListener("change", (e) => {
      visibleCount = e.matches ? desktopCount : mobileCount;
      start = 0;
      if (timer) clearInterval(timer);
      render();
      startTimer();
    });

    // Lưu lại để có thể dừng/khởi động lại nếu nội dung container bị thay
    // đổi động sau này (ví dụ khi tự cập nhật "Bài đọc đề xuất").
    container.__rotatorTimer = timer;
  }

  function initAllRotators() {
    document.querySelectorAll("[data-rotator]").forEach((container) => {
      if (container.__rotatorTimer) {
        clearInterval(container.__rotatorTimer);
      }
      initRotator(container);
    });
  }

  // Cho phép gọi lại từ bên ngoài (ví dụ sau khi 1 danh sách được nạp lại
  // bằng JS, giống cách reader.ejs gọi lại window.initReaderPlayer()).
  window.initAllRotators = initAllRotators;

  document.addEventListener("DOMContentLoaded", initAllRotators);
})();