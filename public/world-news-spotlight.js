// =========================================================
// public/world-news-spotlight.js
// Hiệu ứng RIÊNG cho khối "Điểm báo quốc tế" — khác hẳn rotator.js
// (Video mới nhất từ các kênh) và mosaic-hero.js (mosaic tổng quan):
//
//   - Luôn hiện 1 "cửa sổ" N bài cùng lúc: 2 bài ở mobile, 4 bài ở PC
//     (ngưỡng đổi lấy từ data-wn-desktop-breakpoint).
//   - Trong 1 cửa sổ, LẦN LƯỢT từng bài được "spotlight" — tự phóng to
//     nhẹ + đổ bóng, giống hiệu ứng hover nhưng chạy tự động, không cần
//     người dùng chạm vào.
//   - Sau khi đã spotlight hết N bài trong cửa sổ hiện tại -> đổi cả
//     cửa sổ sang N bài tiếp theo trong danh sách, quay vòng hết danh
//     sách rồi lặp lại từ đầu.
//   - Ảnh lỗi thật sự (bắt bằng sự kiện "error" CHUẨN của <img>, không
//     đoán trước) -> ẩn ảnh, hiện chữ tiêu đề tự chạy (marquee) ngay
//     trong khung ảnh, thay vì icon tĩnh như trước.
// =========================================================

(function () {
  function initSpotlight(container) {
    const items = Array.from(container.children);
    if (items.length === 0) return;

    function getVisibleCount() {
      const breakpoint = parseInt(container.getAttribute("data-wn-desktop-breakpoint") || "720", 10);
      const desktopCount = parseInt(container.getAttribute("data-wn-desktop-count") || "4", 10);
      const mobileCount = parseInt(container.getAttribute("data-wn-mobile-count") || "2", 10);
      return window.innerWidth >= breakpoint ? desktopCount : mobileCount;
    }

    const tickMs = parseInt(container.getAttribute("data-wn-spotlight-interval") || "2800", 10);

    let visibleCount = Math.min(getVisibleCount(), items.length);
    let batchStart = 0; // vị trí bài đầu tiên của "cửa sổ" đang hiện
    let spotlightIndex = 0; // 0..visibleCount-1, bài nào trong cửa sổ đang được phóng to

    function renderBatch() {
      items.forEach((el, i) => {
        const offset = ((i - batchStart) % items.length + items.length) % items.length;
        const visible = offset < visibleCount;
        el.classList.toggle("wn-visible", visible);
        if (!visible) el.classList.remove("wn-spotlight-active");
      });
    }

    function applySpotlight() {
      items.forEach((el) => el.classList.remove("wn-spotlight-active"));
      const idx = (batchStart + spotlightIndex) % items.length;
      items[idx].classList.add("wn-spotlight-active");
    }

    function tick() {
      spotlightIndex++;
      if (spotlightIndex >= visibleCount) {
        // Đã phóng to lần lượt hết cả cửa sổ -> chuyển sang lô bài mới.
        spotlightIndex = 0;
        batchStart = (batchStart + visibleCount) % items.length;
        renderBatch();
      }
      applySpotlight();
    }

    renderBatch();
    applySpotlight();

    if (items.length > 1) {
      const timer = setInterval(() => {
        // Tab đang ẩn -> tạm dừng, tránh dồn hiệu ứng khi quay lại tab.
        if (document.hidden) return;
        tick();
      }, tickMs);
      container.__wnSpotlightTimer = timer;
    }

    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const next = Math.min(getVisibleCount(), items.length);
        if (next !== visibleCount) {
          visibleCount = next;
          spotlightIndex = 0;
          renderBatch();
          applySpotlight();
        }
      }, 200);
    });
  }

  // Chữ gõ (typewriter) LUÔN chạy cho MỌI khung, không cần chờ ảnh lỗi
  // nữa — chỉ khác KIỂU HIỂN THỊ (đổi bằng CSS qua class
  // wn-thumb--img-error, xem style.css):
  //   - Có ảnh thật: chữ chạy thành dải nhỏ dưới CHÂN ảnh.
  //   - Không có ảnh thật (ảnh dự phòng tự sinh, nhận ra ngay từ đầu qua
  //     tiền tố "data:image/svg", hoặc ảnh THẬT lỗi tải — sự kiện "error"
  //     chuẩn của <img>): chữ chạy phủ TOÀN khung, chữ to hơn.
  const TYPE_CHAR_MS = 55; // tốc độ gõ, mili-giây/ký tự
  const TYPE_PAUSE_MS = 2200; // dừng lại sau khi gõ xong trước khi gõ lại

  function startTypewriter(marqueeEl) {
    if (marqueeEl.__wnTypeTimer) return; // đã chạy rồi thì khỏi khởi động lại
    const textEl = marqueeEl.querySelector(".wn-type-text");
    const title = marqueeEl.getAttribute("data-title") || "";
    if (!textEl || !title) return;

    let i = 0;
    function typeStep() {
      i++;
      textEl.textContent = title.slice(0, i);
      if (i < title.length) {
        marqueeEl.__wnTypeTimer = setTimeout(typeStep, TYPE_CHAR_MS);
      } else {
        // Gõ xong cả câu -> dừng 1 lúc rồi gõ lại từ đầu, lặp vô hạn.
        marqueeEl.__wnTypeTimer = setTimeout(() => {
          i = 0;
          textEl.textContent = "";
          marqueeEl.__wnTypeTimer = setTimeout(typeStep, TYPE_CHAR_MS);
        }, TYPE_PAUSE_MS);
      }
    }
    typeStep();
  }

  function markNoRealImage(thumb) {
    thumb.classList.add("wn-thumb--img-error");
  }

  function bindImageHandlers(container) {
    container.querySelectorAll(".wn-thumb").forEach((thumb) => {
      const marquee = thumb.querySelector(".wn-marquee");
      if (marquee) startTypewriter(marquee); // luôn gõ chữ, có ảnh hay không

      const img = thumb.querySelector(".wn-img");
      if (!img) return;

      const src = img.getAttribute("src") || "";
      if (src.indexOf("data:image/svg") === 0) {
        markNoRealImage(thumb);
        return;
      }
      img.addEventListener("error", () => markNoRealImage(thumb));
    });
  }

  function initAll() {
    document.querySelectorAll("[data-wn-spotlight]").forEach((container) => {
      if (container.__wnSpotlightTimer) clearInterval(container.__wnSpotlightTimer);
      bindImageHandlers(container);
      initSpotlight(container);
    });
  }

  document.addEventListener("DOMContentLoaded", initAll);
})();