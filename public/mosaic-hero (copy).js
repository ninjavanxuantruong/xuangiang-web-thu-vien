// =========================================================
// public/mosaic-hero.js
// 6 khối cố định theo chủ đề. Mỗi khối HTML có sẵn thuộc tính
// data-mosaic-zone="ten-khoi" khớp đúng tên field trong dữ liệu JSON
// server gửi xuống (xem mosaicFeed.js).
//
// Cách chuyển ảnh: điều khiển thẳng transform/opacity bằng JS (inline
// style), KHÔNG dùng thêm/xoá class CSS. Mỗi lần đổi ảnh, ảnh mới trượt
// vào từ 1 trong 4 hướng ngẫu nhiên, ảnh cũ trượt ra hướng đối diện.
//
// SỬA LỖI (so với bản trước): bản cũ dùng biến `current` bên trong
// callback requestAnimationFrame, nhưng `current = incoming` lại chạy
// TRƯỚC callback đó -> ảnh mới bị chính callback đẩy ra ngoài + opacity 0,
// ảnh cũ thì bị xoá => khung đen. Bản này "chốt" ảnh cũ vào biến riêng
// (outgoing) ngay từ đầu, callback chỉ dùng biến đã chốt đó.
// =========================================================

(function () {
  const DIRECTIONS = ["top", "bottom", "left", "right"];
  const BASE_INTERVAL_MS = 4000;
  const JITTER_MS = 2500;
  const TRANSITION_MS = 600;

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
      return `<img class="mosaic-img" src="${esc(item.image)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;" />`;
    }
    return renderColorBlock(item);
  }

  // Tạo 1 slide, đặt sẵn trạng thái ban đầu qua inline style.
  function buildSlide(item) {
    const el = document.createElement("div");
    el.style.position = "absolute";
    el.style.inset = "0";
    el.style.transition = `transform ${TRANSITION_MS}ms ease, opacity ${TRANSITION_MS}ms ease`;
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

  function initZone(zoneEl, items) {
    if (!items || items.length === 0) {
      zoneEl.style.display = "none";
      return;
    }

    let index = 0;
    zoneEl.innerHTML = "";
    if (!zoneEl.style.position) zoneEl.style.position = "relative";

    let current = buildSlide(items[0]);
    current.style.transform = "translate(0, 0)";
    current.style.opacity = "1";
    current.style.zIndex = "2";
    zoneEl.appendChild(current);

    if (items.length === 1) return;

    function nextSlide() {
      // Tab đang ẩn: trình duyệt tạm dừng requestAnimationFrame, đổi ảnh
      // lúc này dễ làm lệch trạng thái -> bỏ qua, lần sau tự đổi tiếp.
      if (document.hidden) return;

      try {
        index = (index + 1) % items.length;
        const direction = pickRandom(DIRECTIONS);

        // CHỐT ảnh cũ ngay tại đây, trước khi gán lại `current`.
        const outgoing = current;
        const incoming = buildSlide(items[index]);

        // Trạng thái BAN ĐẦU của ảnh mới: nằm ngoài khung hình, trong suốt.
        incoming.style.transform = offscreenTransform(direction);
        incoming.style.opacity = "0";
        incoming.style.zIndex = "2";
        zoneEl.appendChild(incoming);

        // Ép trình duyệt "chốt" trạng thái ban đầu trước khi đổi, nếu không
        // transition sẽ không chạy.
        // eslint-disable-next-line no-unused-expressions
        incoming.offsetHeight;

        // Cập nhật ngay: từ giờ "ảnh hiện tại" là ảnh mới.
        current = incoming;

        // Khung hình kế tiếp: chỉ dùng `incoming` và `outgoing` đã chốt
        // (KHÔNG dùng `current`) để không bị nhầm ảnh.
        requestAnimationFrame(() => {
          incoming.style.transform = "translate(0, 0)";
          incoming.style.opacity = "1";

          outgoing.style.zIndex = "1";
          outgoing.style.transform = offscreenTransform(oppositeDirection(direction));
          outgoing.style.opacity = "0";
        });

        // Dọn ảnh cũ sau khi chuyển động xong.
        setTimeout(() => outgoing.remove(), TRANSITION_MS + 150);
      } catch (err) {
        // Lỗi 1 lần đổi ảnh không làm hỏng khối vĩnh viễn — setInterval vẫn
        // chạy, lần sau tự thử lại.
        console.warn("mosaic-hero: lỗi đổi ảnh, bỏ qua lần này -", err.message);
      }
    }

    const myInterval = BASE_INTERVAL_MS + Math.random() * JITTER_MS;
    setInterval(nextSlide, myInterval);
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

    document.querySelectorAll("[data-mosaic-zone]").forEach((zoneEl) => {
      const key = zoneEl.getAttribute("data-mosaic-zone");
      initZone(zoneEl, zones[key] || []);
    });
  }

  document.addEventListener("DOMContentLoaded", initMosaic);
})();