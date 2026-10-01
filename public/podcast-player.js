// =========================================================
// public/podcast-player.js
// Player podcast tuỳ chỉnh: nút play/tạm dừng, thanh trượt tua, lùi/tiến
// 15 giây, hiện thời gian đã phát / tổng thời lượng, tiêu đề tự chạy chữ
// nếu quá dài khung hiển thị.
// =========================================================

(function () {
  const wrap = document.getElementById("podcastPlayer");
  const audio = document.getElementById("ppAudio");
  if (!wrap || !audio) return;

  const btnPlay = document.getElementById("ppPlayPause");
  const btnBack = document.getElementById("ppBack15");
  const btnFwd = document.getElementById("ppFwd15");
  const seek = document.getElementById("ppSeek");
  const elCurrent = document.getElementById("ppCurrent");
  const elDuration = document.getElementById("ppDuration");
  const elTitle = document.getElementById("ppTitle");

  let dangKeo = false; // người dùng đang kéo thanh trượt bằng tay -> tạm ngưng tự cập nhật

  function dinhDangThoiGian(giay) {
    if (!Number.isFinite(giay) || giay < 0) return "0:00";
    const m = Math.floor(giay / 60);
    const s = Math.floor(giay % 60)
      .toString()
      .padStart(2, "0");
    return `${m}:${s}`;
  }

  function nap() {
    if (audio.src) return; // đã nạp rồi (preload="none" -> chỉ nạp khi bấm phát lần đầu)
    audio.src = wrap.getAttribute("data-src");
  }

  function phatHoacTamDung() {
    nap();
    if (audio.paused) {
      audio.play().catch((err) => console.warn("podcast: không phát được -", err.message));
    } else {
      audio.pause();
    }
  }

  btnPlay.addEventListener("click", phatHoacTamDung);

  audio.addEventListener("play", () => {
    wrap.classList.add("is-playing");
    btnPlay.textContent = "⏸";
  });
  audio.addEventListener("pause", () => {
    wrap.classList.remove("is-playing");
    btnPlay.textContent = "▶";
  });

  audio.addEventListener("loadedmetadata", () => {
    elDuration.textContent = dinhDangThoiGian(audio.duration);
  });

  audio.addEventListener("timeupdate", () => {
    if (dangKeo) return;
    elCurrent.textContent = dinhDangThoiGian(audio.currentTime);
    if (audio.duration > 0) {
      seek.value = String((audio.currentTime / audio.duration) * 100);
    }
  });

  seek.addEventListener("input", () => {
    dangKeo = true;
    elCurrent.textContent = dinhDangThoiGian((seek.value / 100) * (audio.duration || 0));
  });
  seek.addEventListener("change", () => {
    if (audio.duration > 0) {
      audio.currentTime = (seek.value / 100) * audio.duration;
    }
    dangKeo = false;
  });

  btnBack.addEventListener("click", () => {
    nap();
    audio.currentTime = Math.max(0, (audio.currentTime || 0) - 15);
  });
  btnFwd.addEventListener("click", () => {
    nap();
    audio.currentTime = Math.min(audio.duration || Infinity, (audio.currentTime || 0) + 15);
  });

  // Tiêu đề dài quá khung hiển thị -> tự chạy chữ (marquee) nhẹ nhàng.
  function kiemTraChayChu() {
    if (elTitle.scrollWidth > elTitle.parentElement.clientWidth + 4) {
      elTitle.classList.add("pp-title--scroll");
    } else {
      elTitle.classList.remove("pp-title--scroll");
    }
  }
  kiemTraChayChu();
  window.addEventListener("resize", kiemTraChayChu);
})();