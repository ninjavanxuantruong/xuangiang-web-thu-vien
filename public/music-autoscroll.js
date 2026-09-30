// =========================================================
// public/music-autoscroll.js
// Nút nhạc nền: bật lên thì phát nhạc VÀ tự cuộn trang lần lượt qua từng
// khối ".section", đến cuối thì quay ngược lên trên, cứ vậy lặp lại. Tắt
// nhạc thì dừng cả nhạc lẫn tự cuộn, trả quyền cuộn trang lại cho người dùng.
// =========================================================

(function () {
  const SCROLL_INTERVAL_MS = 12000; // 12 giây/lần di chuyển

  const btn = document.getElementById("musicToggleBtn");
  const audio = document.getElementById("bgMusic");
  if (!btn || !audio) return;

  let dangPhat = false;
  let scrollTimer = null;
  let idx = 0;
  let dir = 1; // 1 = xuống, -1 = lên

  function layDanhSachSection() {
    return Array.from(document.querySelectorAll(".section"));
  }

  function cuonToiSection(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function tick() {
    const sections = layDanhSachSection();
    if (sections.length === 0) return;

    cuonToiSection(sections[idx]);

    // Tới cuối thì quay đầu, tới đầu thì lại đi xuống — lặp vô hạn.
    if (idx >= sections.length - 1) dir = -1;
    else if (idx <= 0) dir = 1;

    idx += dir;
    idx = Math.max(0, Math.min(sections.length - 1, idx));
  }

  function batNhac() {
    audio.play().catch(() => {
      // Trình duyệt chặn autoplay có âm thanh khi chưa tương tác — nhưng
      // đây là do người dùng tự bấm nút nên luôn được phép, catch chỉ để
      // phòng lỗi mạng khi tải file nhạc.
    });
    dangPhat = true;
    btn.classList.add("is-playing");
    document.body.classList.add("is-autoplaying");

    idx = 0;
    dir = 1;
    tick(); // di chuyển ngay lần đầu, không đợi hết 12s mới chạy
    scrollTimer = setInterval(tick, SCROLL_INTERVAL_MS);
  }

  function tatNhac() {
    audio.pause();
    dangPhat = false;
    btn.classList.remove("is-playing");
    document.body.classList.remove("is-autoplaying");

    if (scrollTimer) {
      clearInterval(scrollTimer);
      scrollTimer = null;
    }
  }

  btn.addEventListener("click", () => {
    if (dangPhat) tatNhac();
    else batNhac();
  });
})();