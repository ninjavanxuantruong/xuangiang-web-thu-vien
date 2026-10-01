// =========================================================
// public/xung-danh.js
// Popup "xưng danh": tên + chi bộ, lưu 1 lần bằng cookie (server đặt),
// lần sau vào lại không hỏi nữa. Bấm "Bỏ qua" thì KHÔNG lưu gì cả — lần
// sau vào lại vẫn hỏi tiếp (đúng ý đã chốt).
//
// Cần server render sẵn (trong home-content.ejs) các biến:
//   window.__XUNG_DANH_CAN_HOI__  (boolean) — chưa có cookie thì true
//   window.__CHI_BO_LIST__        ([{id,name}, ...])
//   window.__CSRF_TOKEN__         (chuỗi)
// =========================================================

(function () {
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    });
    (children || []).forEach((c) => node.appendChild(c));
    return node;
  }

  function buildPopup(chiBoList) {
    const overlay = el("div", { id: "xungDanhOverlay", class: "xd-overlay" });
    const box = el("div", { class: "xd-box" });

    box.appendChild(el("div", { class: "xd-title", text: "Xin chào bạn 👋" }));
    box.appendChild(
      el("div", {
        class: "xd-desc",
        text: "Vui lòng cho biết họ tên và chi bộ của bạn"
      })
    );

    const nameInput = el("input", {
      type: "text",
      id: "xdName",
      class: "xd-input",
      placeholder: "Họ và tên",
      maxlength: "100"
    });
    box.appendChild(nameInput);

    const select = el("select", { id: "xdChiBo", class: "xd-input" });
    select.appendChild(el("option", { value: "", text: "— Chọn chi bộ —" }));
    chiBoList.forEach((cb) => {
      select.appendChild(el("option", { value: cb.id, text: cb.name }));
    });
    box.appendChild(select);

    const errorBox = el("div", { class: "xd-error", style: "display:none;" });
    box.appendChild(errorBox);

    const row = el("div", { class: "xd-row" });
    const skipBtn = el("button", { type: "button", class: "xd-btn xd-skip", text: "Bỏ qua" });
    const okBtn = el("button", { type: "button", class: "xd-btn xd-ok", text: "Xác nhận" });
    row.append(skipBtn, okBtn);
    box.appendChild(row);

    overlay.appendChild(box);

    function showError(msg) {
      errorBox.textContent = msg;
      errorBox.style.display = "block";
    }

    skipBtn.addEventListener("click", () => {
      overlay.remove(); // không lưu gì -> lần sau vào lại vẫn hỏi tiếp
    });

    okBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      const chiBoId = select.value;
      const chiBoName = select.options[select.selectedIndex]?.text || "";

      if (!name) return showError("Vui lòng nhập họ tên.");
      if (!chiBoId) return showError("Vui lòng chọn chi bộ.");

      okBtn.disabled = true;
      okBtn.textContent = "Đang lưu...";
      try {
        const res = await fetch("/xung-danh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, chiBoId, chiBoName, _csrf: window.__CSRF_TOKEN__ })
        });
        if (!res.ok) throw new Error("server từ chối");

        overlay.remove();
        updateHeaderButton(name);
      } catch (err) {
        showError("Có lỗi khi lưu, vui lòng thử lại.");
        okBtn.disabled = false;
        okBtn.textContent = "Xác nhận";
      }
    });

    return overlay;
  }

  function updateHeaderButton(name) {
    const btn = document.getElementById("xungDanhBtn");
    if (btn) btn.textContent = "👤 " + name;
  }

  function openPopup() {
    if (document.getElementById("xungDanhOverlay")) return; // đã mở sẵn
    const chiBoList = window.__CHI_BO_LIST__ || [];
    document.body.appendChild(buildPopup(chiBoList));
  }

  function init() {
    const btn = document.getElementById("xungDanhBtn");
    if (btn) btn.addEventListener("click", openPopup);

    if (window.__XUNG_DANH_CAN_HOI__) openPopup();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
