'use strict';

// ══════════════════════════════════════════════
// RICH MEDIA — Emojis, Giphy GIFs, Stickers
// ══════════════════════════════════════════════

const EMOJI_BLOCKS = [
  [0x1F600, 0x1F64F],
  [0x1F300, 0x1F5FF],
  [0x1F680, 0x1F6FF],
  [0x1F900, 0x1F9FF],
  [0x1FA70, 0x1FAFF],
  [0x2600, 0x26FF],
  [0x2700, 0x27BF]
];

const EMOJI_LIST = Array.from(new Set(
  EMOJI_BLOCKS.flatMap(([start, end]) => {
    const chars = [];
    for (let code = start; code <= end; code += 1) {
      try {
        const emoji = String.fromCodePoint(code);
        if (/\p{Extended_Pictographic}/u.test(emoji)) chars.push(emoji);
      } catch (e) {}
    }
    return chars;
  })
));

const TENOR_API_KEY = 'LIVDULZ6S78F'; // Using a public demo key - User should replace with their own
const TENOR_BASE_URL = 'https://tenor.googleapis.com/v2';

document.addEventListener('DOMContentLoaded', () => {
  const drawerBtn = document.getElementById('media-drawer-btn');
  const drawer    = document.getElementById('media-drawer');
  if (!drawerBtn || !drawer) return;

  // Toggle drawer
  drawerBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isVisible = drawer.classList.contains('drawer-active');
    if (isVisible) {
      drawer.classList.remove('drawer-active');
    } else {
      drawer.classList.add('drawer-active');
      if (document.getElementById('tab-emoji').children.length === 0) loadEmojis();
      loadTrending('gifs'); // Load trending on open
    }
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (drawer.classList.contains('drawer-active') && !drawer.contains(e.target) && e.target !== drawerBtn) {
      drawer.classList.remove('drawer-active');
    }
  });

  // Tab Switching
  document.querySelectorAll('.media-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.media-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.media-tab-content').forEach(c => c.style.display = 'none');
      
      btn.classList.add('active');
      const target = btn.dataset.tab;
      const content = document.getElementById('tab-' + target);
      if (content) {
        content.style.display = (target === 'emoji') ? 'grid' : 'flex';
        if (target === 'gif') loadTrending('gifs');
        if (target === 'sticker') loadTrending('stickers');
      }
    });
  });

  // Search (Shared for GIFs and Stickers)
  const searchInput = document.getElementById('media-search-input');
  let searchTimer = null;
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      clearTimeout(searchTimer);
      const q = e.target.value.trim();
      const activeTab = document.querySelector('.media-tab.active')?.dataset.tab || 'gif';
      
      if (!q) {
        loadTrending(activeTab === 'sticker' ? 'stickers' : 'gifs');
        return;
      }
      
      searchTimer = setTimeout(() => {
        searchMedia(q, activeTab === 'sticker' ? 'stickers' : 'gifs');
      }, 500);
    });
  }

  // ── Tenor Helpers ─────────────────────────────
  
  async function loadTrending(type) {
    const resEl = type === 'stickers' ? document.getElementById('sticker-results') : document.getElementById('gif-results');
    if (!resEl) return;
    if (resEl.dataset.loaded === 'trending' && !document.getElementById('media-search-input').value) return;

    resEl.innerHTML = '<div class="media-loading">Loading Trending...</div>';
    try {
      const endpoint = type === 'stickers' ? '/featured?searchfilter=sticker' : '/featured?';
      const resp = await fetch(`${TENOR_BASE_URL}${endpoint}&key=${TENOR_API_KEY}&limit=12&media_filter=gif,tinygif`);
      if (!resp.ok) throw new Error('API Error');
      const json = await resp.json();
      renderResults(json.results, resEl, type);
      resEl.dataset.loaded = 'trending';
    } catch (e) {
      console.warn('Tenor Trending Error:', e);
      resEl.innerHTML = '<div class="media-error">Service unavailable. Emojis are still working!</div>';
    }
  }

  async function searchMedia(query, type) {
    const resEl = type === 'stickers' ? document.getElementById('sticker-results') : document.getElementById('gif-results');
    if (!resEl) return;

    resEl.innerHTML = '<div class="media-loading">Searching...</div>';
    try {
      const endpoint = type === 'stickers' ? '/search?searchfilter=sticker' : '/search?';
      const resp = await fetch(`${TENOR_BASE_URL}${endpoint}&q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&limit=15&media_filter=gif,tinygif`);
      if (!resp.ok) throw new Error('API Error');
      const json = await resp.json();
      renderResults(json.results, resEl, type);
      resEl.dataset.loaded = 'search';
    } catch (e) {
      console.warn('Tenor Search Error:', e);
      resEl.innerHTML = '<div class="media-error">No results or service unavailable.</div>';
    }
  }

  function renderResults(results, container, type) {
    container.innerHTML = '';
    if (!results || results.length === 0) {
      container.innerHTML = '<div class="media-error">No results</div>';
      return;
    }
    
    results.forEach(item => {
      const media = item.media_formats.tinygif || item.media_formats.gif;
      if (!media) return;

      const img = document.createElement('img');
      img.src = media.url;
      img.className = 'media-item';
      img.loading = 'lazy';
      img.onclick = () => {
        const fullMedia = item.media_formats.gif || item.media_formats.tinygif;
        if (!fullMedia?.url) return;
        sendRichMedia(fullMedia.url, type === 'stickers' ? 'sticker' : 'gif');
        drawer.classList.remove('drawer-active');
      };
      container.appendChild(img);
    });
  }

  function loadEmojis() {
    const cont = document.getElementById('tab-emoji');
    if (!cont) return;
    cont.innerHTML = '';
    EMOJI_LIST.forEach(em => {
      const btn = document.createElement('div');
      btn.className   = 'emoji-item';
      btn.textContent = em;
      btn.onclick = () => {
        const input = document.getElementById('msg-input');
        if (input) {
          input.value += em;
          input.dispatchEvent(new Event('input')); // Trigger resize
          input.focus();
        }
      };
      cont.appendChild(btn);
    });
  }
});

function sendRichMedia(url, type) {
  const msg = {
    type: 'rich_media',
    mediaType: type, // 'gif' or 'sticker'
    url: url,
    id: crypto.randomUUID(),
    from: myUsername,
    ts: Date.now(),
    disappearing: (typeof isDisappearingMode !== 'undefined' && isDisappearingMode)
  };
  rememberMessage(msg);
  renderRichMediaMessage(msg, true);
  if (typeof broadcastOrRelay === 'function') broadcastOrRelay(msg);
  
  if (msg.disappearing && typeof setMessageTimer === 'function') {
    setMessageTimer(msg.id, typeof DISAPPEAR_SECONDS !== 'undefined' ? DISAPPEAR_SECONDS : 60, true);
  }
}

function sendRichMedia(url, type) {
  const msg = {
    type: 'rich_media',
    mediaType: type,
    url,
    id: crypto.randomUUID(),
    from: myUsername,
    ts: Date.now(),
    replyTo: typeof buildReplyPayload === 'function' ? buildReplyPayload() : null,
    deliveredAt: null,
    readAt: null,
    disappearing: (typeof isDisappearingMode !== 'undefined' && isDisappearingMode)
  };
  rememberMessage(msg);
  renderRichMediaMessage(msg, true);
  if (typeof broadcastOrRelay === 'function') broadcastOrRelay(msg);
  if (typeof clearPendingReply === 'function') clearPendingReply();

  if (msg.disappearing && typeof setMessageTimer === 'function') {
    setMessageTimer(msg.id, typeof DISAPPEAR_SECONDS !== 'undefined' ? DISAPPEAR_SECONDS : 60, true);
  }
}
