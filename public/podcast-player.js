// =========================================================
// public/podcast-player.js
// Player podcast nhiều bài: nút play/tạm dừng, thanh trượt tua, lùi/tiến
// 15 giây, bài trước / bài sau, danh sách bài (bấm để nghe), hết bài tự
// chuyển sang bài kế tiếp, hiện thời gian đã phát / tổng thời lượng, tiêu
// đề tự chạy chữ nếu quá dài khung hiển thị.
// =========================================================

(function () {
  const wrap = document.getElementById("podcastPlayer");
  const audio = document.getElementById("ppAudio");
  if (!wrap || !audio) return;

  const btnPlay = document.getElementById("ppPlayPause");
  const btnBack = document.getElementById("ppBack15");
  const btnFwd = document.getElementById("ppFwd15");
  const btnPrev = document.getElementById("ppPrev");
  const btnNext = document.getElementById("ppNext");
  const seek = document.getElementById("ppSeek");
  const elCurrent = document.getElementById("ppCurrent");
  const elDuration = document.getElementById("ppDuration");
  const elTitle = document.getElementById("ppTitle");
  const elStatus = document.getElementById("ppStatus");
  const elList = document.getElementById("ppPlaylist");

  const items = Array.from(wrap.querySelectorAll(".pp-item"));
  // Có danh sách thì lấy từ danh sách; không thì chỉ 1 bài như bản cũ (data-src).
  const tracks = items.length
    ? items.map((li) => ({ src: li.dataset.src, title: li.dataset.title || "" }))
    : [{ src: wrap.getAttribute("data-src"), title: elTitle ? elTitle.textContent : "" }];

  let index = 0; // bài đang chọn
  let daNap = false; // đã gán src cho thẻ audio chưa (preload="none" -> chỉ nạp khi bấm)
  let dangKeo = false; // người dùng đang kéo thanh trượt bằng tay -> tạm ngưng tự cập nhật

  function dinhDangThoiGian(giay) {
    if (!Number.isFinite(giay) || giay < 0) return "0:00";
    const m = Math.floor(giay / 60);
    const s = Math.floor(giay % 60)
      .toString()
      .padStart(2, "0");
    return `${m}:${s}`;
  }

  function datTrangThai(text) {
    if (elStatus) elStatus.textContent = text || "";
  }

  // Tiêu đề dài quá khung hiển thị -> tự chạy chữ (marquee) nhẹ nhàng.
  function kiemTraChayChu() {
    if (!elTitle || !elTitle.parentElement) return;
    elTitle.classList.remove("pp-title--scroll");
    if (elTitle.scrollWidth > elTitle.parentElement.clientWidth + 4) {
      elTitle.classList.add("pp-title--scroll");
    }
  }

  function capNhatGiaoDien() {
    items.forEach((li, i) => li.classList.toggle("is-current", i === index));
    if (elTitle) elTitle.textContent = tracks[index].title;
    if (btnPrev) btnPrev.disabled = index <= 0;
    if (btnNext) btnNext.disabled = index >= tracks.length - 1;
    kiemTraChayChu();

    // Cuộn BÊN TRONG khung danh sách tới bài đang chọn (không cuộn cả trang).
    const li = items[index];
    if (li && elList) {
      const top = li.offsetTop - elList.offsetTop;
      if (top < elList.scrollTop || top + li.offsetHeight > elList.scrollTop + elList.clientHeight) {
        elList.scrollTop = Math.max(0, top - 8);
      }
    }
  }

  function nap() {
    if (daNap) return;
    audio.src = tracks[index].src;
    daNap = true;
  }

  function chonBai(i, tuPhat) {
    if (i < 0 || i >= tracks.length) return;
    index = i;
    audio.src = tracks[i].src;
    daNap = true;
    elCurrent.textContent = "0:00";
    elDuration.textContent = "0:00";
    seek.value = "0";
    datTrangThai("");
    capNhatGiaoDien();
    if (tuPhat) {
      audio.play().catch((err) => console.warn("podcast: không phát được -", err.message));
    }
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
  if (btnPrev) btnPrev.addEventListener("click", () => chonBai(index - 1, !audio.paused || daNap));
  if (btnNext) btnNext.addEventListener("click", () => chonBai(index + 1, !audio.paused || daNap));

  items.forEach((li, i) => {
    li.addEventListener("click", () => {
      if (i === index && daNap) {
        phatHoacTamDung(); // bấm lại bài đang chọn: phát / tạm dừng
      } else {
        chonBai(i, true);
      }
    });
  });

  audio.addEventListener("play", () => {
    wrap.classList.add("is-playing");
    btnPlay.textContent = "⏸";
  });
  audio.addEventListener("pause", () => {
    wrap.classList.remove("is-playing");
    btnPlay.textContent = "▶";
  });

  // Bài lần đầu được nghe có thể phải chờ server tải từ Drive về -> báo cho người nghe biết.
  audio.addEventListener("waiting", () => {
    wrap.classList.add("is-loading");
    datTrangThai("Đang tải bài này, vui lòng chờ…");
  });
  ["playing", "canplay", "loadeddata"].forEach((ev) =>
    audio.addEventListener(ev, () => {
      wrap.classList.remove("is-loading");
      datTrangThai("");
    })
  );
  audio.addEventListener("error", () => {
    wrap.classList.remove("is-loading");
    datTrangThai("Không phát được bài này, hãy thử lại sau hoặc chọn bài khác.");
  });

  // Hết bài -> tự sang bài kế tiếp (nếu còn).
  audio.addEventListener("ended", () => {
    if (index < tracks.length - 1) {
      chonBai(index + 1, true);
    } else {
      wrap.classList.remove("is-playing");
      btnPlay.textContent = "▶";
    }
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

  capNhatGiaoDien();
  window.addEventListener("resize", kiemTraChayChu);
})();