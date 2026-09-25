// public/splash.js
// Màn chờ trước khi vào trang chủ. "Đã load xong" = CẢ 2 điều kiện:
//   1) window.onload (ảnh/video/iframe trên trang đã tải xong)
//   2) "Bài đọc đề xuất" đã xác định xong bài viết cho MỌI nguồn (found:
//      true hết) — vì server cố tình trả kết quả nhanh/chưa đủ lúc đầu,
//      rồi xử lý các nguồn còn thiếu ở nền (xem initSuggestedPostsAutoRefresh
//      trong main.js) — nên phải tự hỏi lại /api/bai-doc-de-xuat cho tới khi
//      đủ, có giới hạn thời gian chờ tối đa để không treo mãi nếu 1 nguồn
//      tin bị lỗi vĩnh viễn.
// Chữ gõ dần + ảnh mờ dần chạy song song với việc chờ 2 điều kiện trên. Ai
// xong trước thì đợi/đẩy nhanh cho khớp, xong cả 2 mới ẩn màn chờ.

(function () {
  const overlay = document.getElementById("splashOverlay");
  if (!overlay) return; // trang không có splash thì bỏ qua

  const imgEl = document.getElementById("splashImg");
  const textEl = document.getElementById("splashTypedText");
  const cursorEl = document.getElementById("splashCursor");

  // Kích hoạt hiệu ứng ảnh mờ dần hiện lên (cần 1 nhịp requestAnimationFrame
  // để trình duyệt nhận ra thay đổi class và chạy transition CSS).
  if (imgEl) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => imgEl.classList.add("splash-img-show"));
    });
  }

  const FULL_TEXT = "Xuân Giang: Đoàn kết - Dân chủ - Kỷ cương - Sáng tạo - Phát triển";
  const NORMAL_CHAR_MS = 70; // tốc độ gõ bình thường (ms/ký tự)
  const FAST_CHAR_MS = 6; // tốc độ gõ khi cần đẩy nhanh cho xong

  const SUGGESTED_POLL_MS = 1500; // hỏi lại /api/bai-doc-de-xuat mỗi 1.5s
  const SUGGESTED_MAX_WAIT_MS = 25000; // chờ tối đa 25s, tránh treo mãi

  let charIndex = 0;
  let typingTimer = null;
  let typingDone = false;
  let windowLoaded = false;
  let suggestedReady = false;
  let speedUp = false;

  function typeNextChar() {
    if (charIndex >= FULL_TEXT.length) {
      typingDone = true;
      if (pageFullyReady()) {
        hideSplash();
        return;
      }
      // Trang chưa tải xong -> dừng 1 nhịp ngắn rồi GÕ LẠI TỪ ĐẦU, lặp
      // liên tục cho tới khi đủ dữ liệu mới thôi (thay vì gõ 1 lần rồi
      // đứng im nhấp nháy con trỏ như trước).
      typingTimer = setTimeout(() => {
        charIndex = 0;
        textEl.textContent = "";
        typingDone = false;
        typeNextChar();
      }, speedUp ? 200 : 900);
      return;
    }
    textEl.textContent += FULL_TEXT[charIndex];
    charIndex++;
    typingTimer = setTimeout(typeNextChar, speedUp ? FAST_CHAR_MS : NORMAL_CHAR_MS);
  }

  function pageFullyReady() {
    return windowLoaded && suggestedReady;
  }

  function maybeHide() {
    if (typingDone && pageFullyReady()) hideSplash();
  }

  function hideSplash() {
    if (typingTimer) clearTimeout(typingTimer);
    overlay.classList.add("splash-hide");
    setTimeout(() => overlay.remove(), 700); // khớp thời gian CSS ẩn dần
  }

  window.addEventListener("load", () => {
    windowLoaded = true;
    if (typingDone) {
      maybeHide();
    } else {
      // Trang đã load xong nhưng chữ chưa gõ hết -> đẩy nhanh phần còn lại
      speedUp = true;
    }
  });

  // ----- Chờ "bài đọc đề xuất" xác định xong hết các nguồn -----
  const suggestedWaitStart = Date.now();

  function checkSuggestedPosts() {
    fetch("/api/bai-doc-de-xuat")
      .then((res) => res.json())
      .then((data) => {
        const posts = data.suggestedPosts || [];
        const allFound = posts.length > 0 && posts.every((p) => p.found);
        const timedOut = Date.now() - suggestedWaitStart > SUGGESTED_MAX_WAIT_MS;

        if (allFound || timedOut) {
          suggestedReady = true;
          // Cập nhật lại đúng nội dung mới nhất trước khi ẩn màn chờ, để
          // người xem không thấy giật/nhảy nội dung ngay sau khi vào trang.
          // (renderHeroSlides/renderSuggestedRow là hàm khai báo top-level
          // trong main.js — script thường (không type="module") nên tự
          // thành thuộc tính của window, gọi được từ đây.)
          if (typeof window.renderHeroSlides === "function") window.renderHeroSlides(posts);
          if (typeof window.renderSuggestedRow === "function") window.renderSuggestedRow(posts);
          maybeHide();
        } else {
          setTimeout(checkSuggestedPosts, SUGGESTED_POLL_MS);
        }
      })
      .catch(() => {
        // Lỗi mạng khi hỏi API -> thôi, không chờ mãi, coi như xong.
        suggestedReady = true;
        maybeHide();
      });
  }
  checkSuggestedPosts();

  typeNextChar();
})();