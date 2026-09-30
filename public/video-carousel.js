// video-carousel.js
// Yêu cầu: window.VIDEOS = [{videoId, title, thumbnail}, ...] đã được set trước khi file này chạy.
// Không cần API key — chỉ dùng YouTube IFrame Player API (miễn phí, không quota).

(function () {
  const CLIP_SECONDS = 6;    // độ dài đoạn phát mỗi vòng
  const START_SECONDS = 0;   // giây bắt đầu trong video gốc

  const carouselEl = document.getElementById('videoCarousel');
  const progressBar = document.getElementById('vcProgressBar');

  if (!carouselEl || !Array.isArray(window.VIDEOS) || window.VIDEOS.length === 0) return;

  let order = [...window.VIDEOS];
  let player = null;
  let clipTimer = null;
  let progressTimer = null;
  let ytApiReady = false;
  let built = false; // đã dựng khung DOM cố định (left/main/right) hay chưa

  window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    if (built) mountMainPlayer(order[0].videoId); // khung đã dựng, chỉ còn thiếu player
    else render();
  };
  (function loadYT() {
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  })();

  function idxLeft()  { return order.length > 1 ? order[order.length - 1] : null; }
  function idxRight() { return order.length > 1 ? order[1 % order.length] : null; }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function sideSlotHTML(video) {
    if (!video) return '';
    return `
      <div class="vc-slot side" data-jump="${video.videoId}">
        <img src="${video.thumbnail}" alt="${escapeHtml(video.title)}" loading="lazy" />
      </div>
      <div class="vc-title">${escapeHtml(video.title)}</div>
    `;
  }

  // Dựng khung DOM MỘT LẦN DUY NHẤT khi trang load.
  // Từ đây về sau KHÔNG bao giờ innerHTML lại toàn bộ carouselEl nữa,
  // vì làm vậy sẽ xoá mất iframe player đang chạy (gây lỗi "not attached to DOM").
  function buildSkeleton() {
    carouselEl.innerHTML = `
      <div class="vc-slot-wrap" id="vcLeftWrap"></div>
      <div class="vc-slot-wrap">
        <div class="vc-slot main" id="vcMainSlot"></div>
        <div class="vc-title" id="vcMainTitle"></div>
      </div>
      <div class="vc-slot-wrap" id="vcRightWrap"></div>
    `;
    built = true;
    bindSideClicks();
  }

  function bindSideClicks() {
    carouselEl.querySelectorAll('[data-jump]').forEach(el => {
      el.addEventListener('click', () => jumpTo(el.dataset.jump));
    });
  }

  // Chỉ cập nhật 2 slot phụ + tiêu đề — không đụng tới slot main (nơi chứa player)
  function updateSides() {
    const main = order[0];
    const left = idxLeft();
    const right = idxRight();

    document.getElementById('vcLeftWrap').innerHTML = sideSlotHTML(left);
    document.getElementById('vcRightWrap').innerHTML = sideSlotHTML(right);
    document.getElementById('vcMainTitle').textContent = main.title;

    bindSideClicks();
  }

  function render() {
    if (!built) buildSkeleton();
    updateSides();
    mountMainPlayer(order[0].videoId);
  }

  function mountMainPlayer(videoId) {
    clearTimers();
    if (!ytApiReady || !window.YT || !window.YT.Player) return; // sẽ được gọi lại khi API sẵn sàng

    if (!player) {
      // Chỉ tạo YT.Player ĐÚNG MỘT LẦN. Các lần sau chỉ loadVideoById.
      player = new YT.Player('vcMainSlot', {
        videoId,
        playerVars: {
          autoplay: 1,
          mute: 1,          // bắt buộc để autoplay hoạt động trên trình duyệt
          controls: 0,
          modestbranding: 1,
          start: START_SECONDS,
          rel: 0,
          playsinline: 1
        },
        events: {
          onReady: onPlayerReady,
          onStateChange: onPlayerStateChange
        }
      });
    } else {
      player.loadVideoById({ videoId, startSeconds: START_SECONDS });
      player.mute();
    }
  }

  function onPlayerReady(e) {
    e.target.mute();
    e.target.playVideo();
    startClipTimer();
  }

  function onPlayerStateChange(e) {
    if (e.data === YT.PlayerState.PLAYING) startClipTimer();
  }

  function startClipTimer() {
    clearTimers();
    const startedAt = Date.now();
    progressTimer = setInterval(() => {
      const pct = Math.min(100, ((Date.now() - startedAt) / (CLIP_SECONDS * 1000)) * 100);
      if (progressBar) progressBar.style.width = pct + '%';
    }, 100);

    clipTimer = setTimeout(nextVideo, CLIP_SECONDS * 1000);
  }

  function clearTimers() {
    clearTimeout(clipTimer);
    clearInterval(progressTimer);
    if (progressBar) progressBar.style.width = '0%';
  }

  function nextVideo() {
    order.push(order.shift());
    updateSides();
    mountMainPlayer(order[0].videoId);
  }

  function jumpTo(videoId) {
    const idx = order.findIndex(v => v.videoId === videoId);
    if (idx === -1) return;
    order = order.slice(idx).concat(order.slice(0, idx));
    updateSides();
    mountMainPlayer(order[0].videoId);
  }

  // Dựng khung ngay (không chờ YT API) để side thumbnails hiện ngay lập tức;
  // player sẽ được gắn vào khi API sẵn sàng (onYouTubeIframeAPIReady ở trên).
  buildSkeleton();
  updateSides();
  if (window.YT && window.YT.Player) {
    ytApiReady = true;
    mountMainPlayer(order[0].videoId);
  }
})();