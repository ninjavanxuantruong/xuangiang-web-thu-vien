// news-carousel.js
// Yêu cầu: window.XA_NEWS = [{title, link, image}, ...] đã set trước khi file này chạy.
// Đơn giản hơn video-carousel.js vì chỉ đổi ảnh/tiêu đề, không có player ngoài
// nào cần giữ nguyên trong DOM — nên có thể cập nhật trực tiếp mỗi vòng.

(function () {
  const ROTATE_SECONDS = 5; // mỗi tin đứng bao lâu ở vị trí chính

  const carouselEl = document.getElementById('newsCarousel');
  const progressBar = document.getElementById('ncProgressBar');

  if (!carouselEl || !Array.isArray(window.XA_NEWS) || window.XA_NEWS.length === 0) return;

  let order = [...window.XA_NEWS];
  let rotateTimer = null;
  let progressTimer = null;

  function idxLeft()  { return order.length > 1 ? order[order.length - 1] : null; }
  function idxRight() { return order.length > 1 ? order[1 % order.length] : null; }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function sideSlotHTML(item) {
    if (!item) return '';
    return `
      <a class="nc-slot side" data-jump="${encodeURIComponent(item.link)}" href="${item.link}" target="_blank" rel="noopener" onclick="return false;">
        <img src="${item.image}" alt="${escapeHtml(item.title)}" loading="lazy" />
      </a>
      <div class="nc-title">${escapeHtml(item.title)}</div>
    `;
  }

  function buildSkeleton() {
    carouselEl.innerHTML = `
      <div class="nc-slot-wrap" id="ncLeftWrap"></div>
      <div class="nc-slot-wrap">
        <a class="nc-slot main" id="ncMainSlot" target="_blank" rel="noopener">
          <img id="ncMainImg" src="" alt="" />
        </a>
        <div class="nc-title" id="ncMainTitle"></div>
      </div>
      <div class="nc-slot-wrap" id="ncRightWrap"></div>
    `;
    bindSideClicks();
  }

  function bindSideClicks() {
    carouselEl.querySelectorAll('[data-jump]').forEach(el => {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        jumpTo(decodeURIComponent(el.dataset.jump));
      });
    });
  }

  function updateSlots() {
    const main = order[0];
    const left = idxLeft();
    const right = idxRight();

    document.getElementById('ncLeftWrap').innerHTML = sideSlotHTML(left);
    document.getElementById('ncRightWrap').innerHTML = sideSlotHTML(right);
    bindSideClicks();

    const mainSlot = document.getElementById('ncMainSlot');
    const mainImg = document.getElementById('ncMainImg');
    const mainTitle = document.getElementById('ncMainTitle');

    // hiệu ứng mờ-hiện nhẹ khi đổi tin, không cần load lại toàn khối
    mainImg.style.opacity = 0;
    setTimeout(() => {
      mainImg.src = main.image;
      mainImg.alt = main.title;
      mainSlot.href = main.link;
      mainTitle.textContent = main.title;
      mainImg.style.opacity = 1;
    }, 180);
  }

  function startRotateTimer() {
    clearTimers();
    const startedAt = Date.now();
    progressTimer = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - startedAt) / (ROTATE_SECONDS * 1000)) * 100);
      if (progressBar) progressBar.style.width = pct + '%';
    }, 100);

    rotateTimer = setTimeout(nextItem, ROTATE_SECONDS * 1000);
  }

  function clearTimers() {
    clearTimeout(rotateTimer);
    clearInterval(progressTimer);
    if (progressBar) progressBar.style.width = '0%';
  }

  function nextItem() {
    order.push(order.shift());
    updateSlots();
    startRotateTimer();
  }

  function jumpTo(link) {
    const idx = order.findIndex(v => v.link === link);
    if (idx === -1) return;
    order = order.slice(idx).concat(order.slice(0, idx));
    updateSlots();
    startRotateTimer();
  }

  buildSkeleton();
  updateSlots();
  startRotateTimer();
})();