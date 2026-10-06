// =========================================================
// public/lich-tuan.js
// Lịch công tác tuần — 2 khối, dùng chung 1 nguồn dữ liệu /api/lich-tuan:
//   1) Dải chữ chạy (#lichTickerWrap): CHỈ lịch của ngày hôm nay, nằm ngay
//      dưới banner Góp ý. Khi bật nhạc (trang tự cuộn), dải tự ghim lên mép
//      trên màn hình — việc ghim do CSS + class "is-autoplaying" trên <body>
//      (xem music-autoscroll.js), file này không cần biết.
//   2) Khối cuối trang (#lichTuanBlock): mỗi ngày 1 trang, các trang tự
//      chuyển tuần tự, BẮT ĐẦU từ hôm nay. Rê chuột/chạm thì dừng.
//
// Nội dung lịch đến từ Google Doc bên ngoài nên KHÔNG dùng innerHTML với
// chữ trong lịch — chỉ dùng textContent để không bị chèn mã.
// Lỗi tải / chưa cấu hình -> cả 2 khối giữ nguyên trạng thái ẩn.
// =========================================================

(function () {
  const PAGE_INTERVAL_MS = 5000; // mỗi trang ngày dừng ~11 giây
  const MANUAL_PAUSE_MS = 10000; // người dùng tự bấm/chạm thì đợi lâu hơn rồi mới tự chạy lại
  const TICKER_PX_PER_SEC = 55; // tốc độ chữ chạy

  // Ngày hôm nay theo giờ Việt Nam, dạng "2026-09-28" (khớp date từ server).
  function homNayVN() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---------- 1) Dải chữ chạy: lịch hôm nay ----------
  function buildTicker(day) {
    const wrap = document.getElementById("lichTickerWrap");
    const track = document.getElementById("ltTrack");
    const viewport = document.getElementById("ltViewport");
    if (!wrap || !track || !viewport) return;

    const parts =
      day.items.length > 0
        ? day.items.map(function (it) {
            return (it.time ? it.time + " " : "") + it.text + (it.who ? " (" + it.who + ")" : "");
          })
        : ["Hôm nay chưa có lịch công tác."];

    const line = day.weekday + " " + day.label + ":  " + parts.join("   ●   ");

    // 2 đoạn giống hệt nhau nối tiếp + CSS dịch -50% => chữ chạy vòng liền mạch.
    track.textContent = "";
    const segA = el("span", "lt-seg", line);
    const segB = el("span", "lt-seg", line);
    segB.setAttribute("aria-hidden", "true");
    track.append(segA, segB);

    wrap.hidden = false;

    // Đoạn ngắn hơn khung nhìn thì kéo dài ra bằng khung để vòng lặp không bị hở.
    const vw = viewport.clientWidth;
    segA.style.minWidth = vw + "px";
    segB.style.minWidth = vw + "px";

    const width = segA.getBoundingClientRect().width;
    const seconds = Math.max(20, width / TICKER_PX_PER_SEC);
    track.style.setProperty("--lt-duration", seconds.toFixed(1) + "s");
  }

  // ---------- 2) Khối các trang theo ngày ----------
  function buildPager(days, startIndex, today) {
    const block = document.getElementById("lichTuanBlock");
    const mount = document.getElementById("ltPager");
    if (!block || !mount) return;

    mount.textContent = "";

    const stack = el("div", "lt-stack");
    const pages = days.map(function (day) {
      const page = el("div", "lt-page");

      const head = el("div", "lt-page-head");
      head.append(el("span", "lt-page-day", day.weekday), el("span", "lt-page-date", day.label));
      if (day.date === today) head.append(el("span", "lt-today", "Hôm nay"));
      page.append(head);

      const list = el("div", "lt-items");
      if (day.items.length === 0) {
        list.append(el("p", "lt-empty", "Chưa có lịch công tác."));
      }
      day.items.forEach(function (it) {
        const row = el("div", "lt-item");
        row.append(el("div", "lt-time", it.time || "•"));
        const body = el("div", "lt-body");
        body.append(el("div", "lt-text", it.text));
        if (it.who) body.append(el("div", "lt-who", it.who));
        row.append(body);
        list.append(row);
      });
      page.append(list);

      stack.append(page);
      return page;
    });
    mount.append(stack);

    const dots = [];
    let index = startIndex;
    let timer = null;

    function show(i) {
      index = (i + days.length) % days.length;
      pages.forEach(function (p, k) {
        p.classList.toggle("is-active", k === index);
      });
      dots.forEach(function (d, k) {
        d.classList.toggle("is-active", k === index);
        if (k === index) d.setAttribute("aria-current", "true");
        else d.removeAttribute("aria-current");
      });
    }

    function schedule(ms) {
      clearTimeout(timer);
      if (days.length < 2) return;
      timer = setTimeout(function () {
        if (!document.hidden) show(index + 1);
        schedule(PAGE_INTERVAL_MS);
      }, ms);
    }

    // Thanh điều hướng: mũi tên + các chấm mang nhãn T2..CN (bấm để nhảy ngày)
    if (days.length > 1) {
      const nav = el("div", "lt-nav");

      const prev = el("button", "lt-arrow", "‹");
      prev.type = "button";
      prev.setAttribute("aria-label", "Ngày trước");
      prev.addEventListener("click", function () {
        show(index - 1);
        schedule(MANUAL_PAUSE_MS);
      });
      nav.append(prev);

      days.forEach(function (day, k) {
        const dot = el("button", "lt-dot", day.short || String(k + 1));
        dot.type = "button";
        dot.setAttribute("aria-label", day.weekday + " " + day.label);
        if (day.date === today) dot.classList.add("is-today");
        dot.addEventListener("click", function () {
          show(k);
          schedule(MANUAL_PAUSE_MS);
        });
        dots.push(dot);
        nav.append(dot);
      });

      const next = el("button", "lt-arrow", "›");
      next.type = "button";
      next.setAttribute("aria-label", "Ngày sau");
      next.addEventListener("click", function () {
        show(index + 1);
        schedule(MANUAL_PAUSE_MS);
      });
      nav.append(next);

      mount.append(nav);
    }

    // Rê chuột: dừng, rời chuột: chạy lại. Chạm: dừng, thả tay: đợi lâu rồi chạy lại.
    mount.addEventListener("mouseenter", function () {
      clearTimeout(timer);
    });
    mount.addEventListener("mouseleave", function () {
      schedule(PAGE_INTERVAL_MS);
    });
    mount.addEventListener(
      "touchstart",
      function () {
        clearTimeout(timer);
      },
      { passive: true }
    );
    mount.addEventListener(
      "touchend",
      function () {
        schedule(MANUAL_PAUSE_MS);
      },
      { passive: true }
    );

    block.hidden = false;
    show(startIndex);
    schedule(PAGE_INTERVAL_MS);
  }

  // Hôm nay nằm ngoài các ngày trong file (chưa cập nhật tuần mới)
  function showStale() {
    const block = document.getElementById("lichTuanBlock");
    const mount = document.getElementById("ltPager");
    if (!block || !mount) return;
    mount.textContent = "";
    mount.append(el("p", "lt-stale", "Lịch công tác tuần chưa được cập nhật."));
    block.hidden = false;
  }

  function init() {
    fetch("/api/lich-tuan")
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        const days = (data && data.days) || [];
        if (days.length === 0) return; // lỗi/chưa cấu hình: giữ ẩn hết

        const today = homNayVN();
        const todayIdx = days.findIndex(function (d) {
          return d.date === today;
        });

        // Dải chữ chạy: chỉ khi hôm nay có trong file
        if (todayIdx >= 0) buildTicker(days[todayIdx]);

        // Trang bắt đầu từ hôm nay; nếu hôm nay không có trong file nhưng nằm
        // GIỮA tuần (vd tuần không ghi ngày lễ) thì bắt đầu từ ngày kế tiếp.
        let start = todayIdx;
        if (start < 0 && today > days[0].date && today < days[days.length - 1].date) {
          start = days.findIndex(function (d) {
            return d.date > today;
          });
        }

        if (start >= 0) buildPager(days, start, today);
        else showStale();
      })
      .catch(function () {
        /* lỗi mạng: giữ nguyên trạng thái ẩn */
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();