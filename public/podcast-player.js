// =========================================================
// public/podcast-player.js
// Podcast phát bằng KHUNG PHÁT CỦA GOOGLE DRIVE (iframe /preview).
// Âm thanh đi thẳng từ Google tới người nghe — KHÔNG đi qua server mình nên
// không tốn băng thông Render (bản cũ phát qua /podcast/audio/<id>).
//
// Giới hạn do khung của Google (khác miền, trang mình không điều khiển được bên trong):
//   - Không tự bấm phát được: người nghe bấm ▶ trong khung của Google.
//   - Không tua ±15 giây, không hiện thanh thời gian của mình, không biết lúc nào
//     hết bài để tự chuyển bài -> hết bài thì bấm ⏭ (hoặc chọn bài trong danh sách).
//   -> Các nút ⏪ ⏩ và thanh tua của bản cũ được ẩn đi.
//
// Cách hoạt động:
//   - Khung Drive chỉ được tạo khi người nghe bấm ▶ hoặc chọn 1 bài (không nạp
//     sẵn lúc mở trang chủ).
//   - Nút chính ▶ / ■: mở khung của bài đang chọn / đóng khung (dừng phát).
//   - ⏮ ⏭ và danh sách: đổi bài; nếu khung đang mở thì mở luôn bài mới.
//   - Bật nhạc nền hay bản tin phát thanh thì khung podcast tự đóng, và ngược lại
//     mở podcast thì các âm thanh khác tự tạm dừng (mỗi lúc chỉ 1 nguồn).
//
// Tương thích markup:
//   - Mới : mỗi bài là <li class="pp-item" data-id="<mã file Drive>" data-title="...">
//           (và/hoặc wrap có data-id cho trường hợp 1 bài).
//   - Cũ  : data-src="/podcast/audio/<mã file Drive>" — mã được tách ra từ đường dẫn.
// =========================================================

(function () {
  const wrap = document.getElementById("podcastPlayer");
  if (!wrap) return;

  const KHUNG_CAO = 150; // px — đủ cho thanh phát của Drive; chỉnh nếu thấy bị cắt
  const ID_HOP_LE = /^[A-Za-z0-9_-]{10,120}$/;

  const btnPlay = document.getElementById("ppPlayPause");
  const btnPrev = document.getElementById("ppPrev");
  const btnNext = document.getElementById("ppNext");
  const elTitle = document.getElementById("ppTitle");
  const elStatus = document.getElementById("ppStatus");
  const elList = document.getElementById("ppPlaylist");

  // ---- Ẩn những thứ khung Drive không làm được (và thẻ <audio> cũ nếu còn) ----
  ["ppBack15", "ppFwd15"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  const seek = document.getElementById("ppSeek");
  if (seek && seek.closest(".pp-progress")) seek.closest(".pp-progress").hidden = true;
  const audioCu = document.getElementById("ppAudio");
  if (audioCu) audioCu.remove();

  // ---- Danh sách bài ----
  function layId(s) {
    const m = String(s || "").match(/([A-Za-z0-9_-]{10,120})\/?$/);
    return m ? m[1] : "";
  }

  const items = Array.from(wrap.querySelectorAll(".pp-item"));
  const tracks = items.length
    ? items.map((li) => ({ id: li.dataset.id || layId(li.dataset.src), title: li.dataset.title || "" }))
    : [
        {
          id: wrap.getAttribute("data-id") || layId(wrap.getAttribute("data-src")),
          title: elTitle ? elTitle.textContent : ""
        }
      ];

  let index = 0; // bài đang chọn
  let khung = null; // <iframe> đang mở (null = chưa mở)
  let hop = null; // hộp chứa khung + link "Mở trên Google Drive"

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
    if (btnPlay) {
      const dangMo = !!khung;
      btnPlay.textContent = dangMo ? "■" : "▶";
      btnPlay.title = dangMo ? "Đóng trình phát" : "Mở trình phát";
      btnPlay.setAttribute("aria-label", dangMo ? "Đóng trình phát" : "Mở trình phát");
    }
    wrap.classList.toggle("is-playing", !!khung);
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

  // Mỗi lúc chỉ 1 nguồn âm thanh: tạm dừng mọi thẻ <audio> khác (nhạc nền, bản tin phát thanh...).
  function dungAmThanhKhac() {
    document.querySelectorAll("audio").forEach((a) => {
      try {
        if (!a.paused) a.pause();
      } catch (e) {
        /* bỏ qua */
      }
    });
  }

  function dongKhung() {
    if (hop && hop.parentNode) hop.parentNode.removeChild(hop);
    hop = null;
    khung = null;
    datTrangThai("");
    capNhatGiaoDien();
  }

  function moKhung() {
    const t = tracks[index];
    if (!t || !ID_HOP_LE.test(t.id)) {
      datTrangThai("Không xác định được file của bài này, hãy chọn bài khác.");
      return;
    }
    dungAmThanhKhac();

    if (!hop) {
      hop = document.createElement("div");
      hop.id = "ppFrameBox";
      hop.style.margin = "10px 0 0";
      // Chèn ngay trước dòng trạng thái (nếu có) cho nằm dưới các nút điều khiển.
      if (elStatus && elStatus.parentNode === wrap) wrap.insertBefore(hop, elStatus);
      else wrap.appendChild(hop);
    }
    hop.textContent = "";

    khung = document.createElement("iframe");
    khung.src = "https://drive.google.com/file/d/" + encodeURIComponent(t.id) + "/preview";
    khung.title = "Phát podcast: " + t.title;
    khung.setAttribute("allow", "autoplay");
    khung.setAttribute("referrerpolicy", "no-referrer");
    khung.style.cssText =
      "display:block;width:100%;height:" + KHUNG_CAO + "px;border:0;border-radius:10px;background:#000;";
    hop.appendChild(khung);

    const lien = document.createElement("a");
    lien.href = "https://drive.google.com/file/d/" + encodeURIComponent(t.id) + "/view";
    lien.target = "_blank";
    lien.rel = "noopener noreferrer";
    lien.textContent = "Mở trên Google Drive ↗";
    lien.style.cssText = "display:inline-block;margin-top:6px;font-size:12px;";
    hop.appendChild(lien);

    datTrangThai(
      tracks.length > 1
        ? "Bấm nút ▶ trong khung bên dưới để nghe. Nghe xong, bấm ⏭ để sang bài kế tiếp."
        : "Bấm nút ▶ trong khung bên dưới để nghe."
    );
    capNhatGiaoDien();
  }

  function chonBai(i, moLuon) {
    if (i < 0 || i >= tracks.length) return;
    index = i;
    if (khung || moLuon) moKhung();
    else capNhatGiaoDien();
  }

  if (btnPlay) btnPlay.addEventListener("click", () => (khung ? dongKhung() : moKhung()));
  if (btnPrev) btnPrev.addEventListener("click", () => chonBai(index - 1, false));
  if (btnNext) btnNext.addEventListener("click", () => chonBai(index + 1, false));

  items.forEach((li, i) => {
    li.addEventListener("click", () => {
      if (i === index && khung) dongKhung(); // bấm lại bài đang mở: đóng
      else chonBai(i, true);
    });
  });

  // Bật nhạc nền / bản tin phát thanh (thẻ <audio> bất kỳ) -> đóng khung podcast để khỏi phát chồng.
  document.addEventListener(
    "play",
    (ev) => {
      if (khung && ev.target && ev.target.tagName === "AUDIO") dongKhung();
    },
    true
  );

  capNhatGiaoDien();
  window.addEventListener("resize", kiemTraChayChu);
})();