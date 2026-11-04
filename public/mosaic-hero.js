// =========================================================
// public/mosaic-hero.js
//
// Khung mosaic có 7 VỊ TRÍ kích thước CỐ ĐỊNH (a-g, xem CSS .mosaic-zone--*)
// — hình dạng lưới không bao giờ đổi. Cái đổi là NỘI DUNG nào (7 chủ đề:
// taiLieu, danhNhan, videoXa, tinXa, baiDeXuat, videoDeXuat, tinTheGioi)
// đang nằm ở vị trí nào:
//   1) Lúc tải trang: random xáo 7 chủ đề vào 7 vị trí.
//   2) Mỗi vị trí, sau khi nhận 1 chủ đề, TỰ XOAY VÒNG các tin của đúng
//      chủ đề đó: ảnh mới trượt vào, ảnh cũ trượt ra hướng đối diện,
//      LIỀN KỀ nhau (như băng chuyền) nên khung luôn được phủ kín.
//   3) Cứ sau RESHUFFLE_INTERVAL_MS, 7 chủ đề được xáo lại và đổi chỗ cho
//      nhau — ảnh của chủ đề mới cũng trượt đè lên ảnh cũ (không có
//      khoảng trống/đen ở giữa).
//
// SỬA LỖI KHUNG ĐEN (so với bản trước) — có 3 nguyên nhân:
//   a) Trong callback requestAnimationFrame dùng biến `current`, nhưng
//      `current = incoming` đã chạy TRƯỚC callback -> ảnh MỚI bị chính
//      callback đẩy ra ngoài khung + opacity 0, còn ảnh cũ thì bị xoá
//      => đen. Bản này chốt `outgoing`/`incoming` thành hằng riêng.
//   b) Ảnh mới + ảnh cũ cùng mờ đi/hiện lên (opacity) nên giữa chuyển động
//      cả hai đều nửa trong suốt, lộ nền đen #111. Bản này KHÔNG dùng
//      opacity nữa, chỉ trượt bằng transform, cả hai luôn đặc 100%.
//   c) Ảnh chưa tải xong đã trượt vào => khung trống. Bản này tải trước
//      ảnh kế tiếp rồi mới trượt; ảnh lỗi thì thay bằng khối màu + tiêu đề.
//   d) Lúc đổi chỗ nội dung, ô từng bị làm mờ về opacity 0 (thấy đen).
//      Bản này bỏ hiệu ứng đó.
// =========================================================

(function () {
  const DIRECTIONS = ["top", "bottom", "left", "right"];
  const BASE_INTERVAL_MS = 4000; // tốc độ đổi ảnh cơ bản trong 1 vị trí
  const JITTER_MS = 2500; // lệch ngẫu nhiên thêm, để các vị trí không đổi ảnh đồng loạt
  const TRANSITION_MS = 600;
  const RESHUFFLE_INTERVAL_MS = 75000; // ~75 giây thì đổi chỗ nội dung giữa các vị trí 1 lần
  const PRELOAD_TIMEOUT_MS = 3000; // chờ tối đa bấy nhiêu giây để ảnh tải xong rồi mới trượt

  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }
  function oppositeDirection(dir) {
    return { top: "bottom", bottom: "top", left: "right", right: "left" }[dir];
  }
  function offscreenTransform(dir) {
    return {
      top: "translateY(-100%)",
      bottom: "translateY(100%)",
      left: "translateX(-100%)",
      right: "translateX(100%)"
    }[dir];
  }

  // Xáo mảng kiểu Fisher-Yates — không thiên vị.
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Tiêu đề/đường dẫn đi vào innerHTML -> escape để không vỡ HTML nếu
  // có dấu " < > & trong tiêu đề bài.
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const DOC_PALETTE = ["#a62626", "#1d6fa5", "#2f7d4f", "#7a5230", "#5c4a8a", "#c46a1f"];
  function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  // Khối màu + chữ (dùng cho mục không có ảnh, và làm dự phòng khi ảnh lỗi)
  function renderColorBlock(item) {
    const color = DOC_PALETTE[hashString(item.title || "") % DOC_PALETTE.length];
    return `<div class="mosaic-fallback" style="width:100%;height:100%;background:${color};display:flex;align-items:center;justify-content:center;padding:8px;">
      <span style="color:#fff;font-size:11px;font-weight:600;text-align:center;line-height:1.3;">${esc(item.title)}</span>
    </div>`;
  }

  function renderSlideContent(item) {
    if (item.kind === "photo" && item.image) {
      return `<img class="mosaic-img" src="${esc(item.image)}" alt="" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover;display:block;" />`;
    }
    return renderColorBlock(item);
  }

  // Tải trước ảnh của 1 mục. Luôn resolve (kể cả khi ảnh lỗi/quá lâu) để
  // vòng xoay không bao giờ bị kẹt; ảnh lỗi sẽ được thay bằng khối màu.
  const loadedImages = new Set();
  function preloadItem(item) {
    return new Promise((resolve) => {
      if (!item || item.kind !== "photo" || !item.image || loadedImages.has(item.image)) {
        resolve();
        return;
      }
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (ok) loadedImages.add(item.image);
        resolve();
      };
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      setTimeout(() => finish(false), PRELOAD_TIMEOUT_MS);
      img.src = item.image;
    });
  }

  // Tạo 1 slide. Chỉ trượt bằng transform (KHÔNG dùng opacity) để slide
  // luôn đặc 100%, không bao giờ lộ nền đen phía sau.
  function buildSlide(item) {
    const el = document.createElement("div");
    el.className = "mosaic-slide";
    el.style.position = "absolute";
    el.style.inset = "0";
    el.style.opacity = "1"; // đè lên CSS .mosaic-slide { opacity: 0 }
    el.style.transition = `transform ${TRANSITION_MS}ms ease`;
    el.innerHTML = `
      <a href="${esc(item.link)}" target="_blank" rel="noopener" style="display:block;width:100%;height:100%;position:relative;">
        ${renderSlideContent(item)}
        <div class="mosaic-caption">
          <span class="mosaic-caption-meta">${esc(item.meta)}</span>
          <span class="mosaic-caption-title">${esc(item.title)}</span>
        </div>
      </a>`;

    // Ảnh lỗi tải (link hết hạn, bị chặn hotlink...) -> thay bằng khối màu
    // + tên bài, thay vì để trống lộ nền đen.
    const img = el.querySelector(".mosaic-img");
    if (img) {
      img.addEventListener("error", () => {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = renderColorBlock(item);
        img.replaceWith(wrapper.firstElementChild);
      });
    }
    return el;
  }

  // Đưa 1 mục vào ô. Nếu ô đã có slide: slide mới trượt vào từ 1 hướng,
  // slide cũ trượt ra hướng đối diện — 2 slide nối liền nhau, luôn phủ kín ô.
  function transitionTo(zoneEl, item) {
    const outgoing = zoneEl._current || null; // CHỐT slide cũ ngay từ đầu
    const incoming = buildSlide(item);
    incoming.style.zIndex = "2";

    if (!outgoing) {
      incoming.style.transform = "translate(0, 0)";
      zoneEl.appendChild(incoming);
      zoneEl._current = incoming;
      return;
    }

    const direction = pickRandom(DIRECTIONS);
    incoming.style.transform = offscreenTransform(direction);
    zoneEl.appendChild(incoming);
    // eslint-disable-next-line no-unused-expressions
    incoming.offsetHeight; // ép chốt trạng thái ban đầu trước khi đổi
    zoneEl._current = incoming;

    // Chỉ dùng incoming/outgoing đã chốt, KHÔNG dùng zoneEl._current.
    requestAnimationFrame(() => {
      incoming.style.transform = "translate(0, 0)";
      outgoing.style.zIndex = "1";
      outgoing.style.transform = offscreenTransform(oppositeDirection(direction));
    });

    // Dọn slide cũ sau khi chuyển động xong.
    setTimeout(() => outgoing.remove(), TRANSITION_MS + 150);
  }

  // Dừng vòng xoay của ô, trả về "token" mới. Mọi tác vụ bất đồng bộ đang
  // chờ (tải ảnh, hẹn giờ) của lần gán cũ sẽ tự huỷ khi thấy token lệch.
  function stopRotation(zoneEl) {
    if (zoneEl._rotationTimer) {
      clearTimeout(zoneEl._rotationTimer);
      zoneEl._rotationTimer = null;
    }
    zoneEl._token = (zoneEl._token || 0) + 1;
    return zoneEl._token;
  }

  function startRotation(zoneEl, items, token) {
    let index = 0;

    function schedule() {
      if (zoneEl._token !== token) return;
      zoneEl._rotationTimer = setTimeout(tick, BASE_INTERVAL_MS + Math.random() * JITTER_MS);
    }

    async function tick() {
      try {
        // Tab đang ẩn: bỏ qua lần này, lần sau thử lại.
        if (!document.hidden) {
          const nextIndex = (index + 1) % items.length;
          await preloadItem(items[nextIndex]); // ảnh sẵn sàng rồi mới trượt
          if (zoneEl._token !== token) return; // đã bị gán chủ đề khác
          index = nextIndex;
          transitionTo(zoneEl, items[index]);
        }
      } catch (err) {
        console.warn("mosaic-hero: lỗi đổi ảnh, bỏ qua lần này -", err.message);
      }
      schedule(); // lỗi 1 lần không làm hỏng vòng xoay
    }

    schedule();
  }

  // Gán 1 chủ đề (mảng items) vào 1 vị trí, bắt đầu xoay vòng từ đầu.
  async function assignContent(zoneEl, items) {
    const token = stopRotation(zoneEl);

    if (!items || items.length === 0) {
      zoneEl.innerHTML = "";
      zoneEl._current = null;
      zoneEl.style.visibility = "hidden"; // không có dữ liệu -> ẩn, khung ô vẫn giữ chỗ
      return;
    }
    zoneEl.style.visibility = "visible";

    await preloadItem(items[0]);
    if (zoneEl._token !== token) return;

    // Ô đang có nội dung cũ thì ảnh đầu của chủ đề mới trượt đè lên,
    // không xoá trắng ô trước -> không bao giờ bị đen.
    transitionTo(zoneEl, items[0]);
    if (items.length > 1) startRotation(zoneEl, items, token);
  }

  // Đổi chủ đề nào đang ở vị trí nào.
  function reshuffle(zoneEls, zoneKeys, zones) {
    const shuffledKeys = shuffle(zoneKeys);
    zoneEls.forEach((zoneEl, i) => {
      const key = shuffledKeys[i % shuffledKeys.length];
      assignContent(zoneEl, zones[key] || []);
    });
  }

  function initMosaic() {
    const dataEl = document.getElementById("mosaicData");
    if (!dataEl) return;

    let zones;
    try {
      zones = JSON.parse(dataEl.textContent || "{}");
    } catch {
      zones = {};
    }

    const zoneKeys = Object.keys(zones);
    const zoneEls = Array.from(document.querySelectorAll("[data-mosaic-position]"));
    if (zoneKeys.length === 0 || zoneEls.length === 0) return;

    // Gán lần đầu — random ngay khi tải trang.
    reshuffle(zoneEls, zoneKeys, zones);

    // Cứ sau RESHUFFLE_INTERVAL_MS thì đổi chỗ nội dung giữa các vị trí 1 lần.
    setInterval(() => reshuffle(zoneEls, zoneKeys, zones), RESHUFFLE_INTERVAL_MS);
  }

  document.addEventListener("DOMContentLoaded", initMosaic);
})();