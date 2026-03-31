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

const FALLBACK_GIFS = [
  { url: "https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif", tags: ["cat", "typing", "work", "computer"] },
  { url: "https://media.giphy.com/media/vFKqnCdLPNOKc/giphy.gif", tags: ["dog", "happy", "smile", "cute"] },
  { url: "https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif", tags: ["wow", "amaze", "surprise", "cat"] },
  { url: "https://media.giphy.com/media/l41lOdm2mFEXhzpe8/giphy.gif", tags: ["clap", "applause", "good", "bravo"] },
  { url: "https://media.giphy.com/media/xT0xeJpnrWC4XWblEk/giphy.gif", tags: ["thumbs up", "yes", "agree", "ok"] },
  { url: "https://media.giphy.com/media/11ISwbgCxEzMyY/giphy.gif", tags: ["no", "never", "refuse", "headshake"] },
  { url: "https://media.giphy.com/media/26AHONQ79FdWZhAI0/giphy.gif", tags: ["dance", "party", "celebrate", "happy"] },
  { url: "https://media.giphy.com/media/5wWf7GMbT1ZUGlTD31g/giphy.gif", tags: ["laugh", "lol", "funny", "haha"] }
];

const FALLBACK_STICKERS = [
  { url: "https://media.giphy.com/media/aBHe0H82A1w0R9bXl0/giphy.gif", tags: ["yes", "sticker", "check", "approve"] },
  { url: "https://media.giphy.com/media/L0qTl8hl84AQgPcgfP/giphy.gif", tags: ["cool", "dog", "sunglasses", "swag"] },
  { url: "https://media.giphy.com/media/8RjQcweNqX1Xk3yJ5K/giphy.gif", tags: ["bye", "wave", "leave", "cya"] },
  { url: "https://media.giphy.com/media/xUOrwaR1d2x5y0vIfu/giphy.gif", tags: ["heart", "love", "cute"] }
];

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

  // Search (Shared for Emojis, GIFs and Stickers)
  const searchInput = document.getElementById('media-search-input');
  let searchTimer = null;
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      clearTimeout(searchTimer);
      const q = e.target.value.trim();
      const activeTab = document.querySelector('.media-tab.active')?.dataset.tab || 'gif';
      
      if (!q) {
        if (activeTab === 'emoji') {
          loadEmojis();
        } else {
          loadTrending(activeTab === 'sticker' ? 'stickers' : 'gifs');
        }
        return;
      }
      
      searchTimer = setTimeout(() => {
        if (activeTab === 'emoji') {
          searchEmojis(q);
        } else {
          searchMedia(q, activeTab === 'sticker' ? 'stickers' : 'gifs');
        }
      }, 500);
    });
  }

  // ── Handlers & Fallbacks ─────────────────────────────
  
  function getMediaSubset(query, type) {
    const dataSource = type === 'stickers' ? FALLBACK_STICKERS : FALLBACK_GIFS;
    if (!query) return dataSource.slice().sort(() => 0.5 - Math.random());
    const lq = query.toLowerCase();
    const filtered = dataSource.filter(g => g.tags.some(t => t.includes(lq) || lq.includes(t)));
    return filtered.length > 0 ? filtered : dataSource.slice().sort(() => 0.5 - Math.random());
  }

  async function loadTrending(type) {
    const resEl = type === 'stickers' ? document.getElementById('sticker-results') : document.getElementById('gif-results');
    if (!resEl) return;
    if (resEl.dataset.loaded === 'trending' && !document.getElementById('media-search-input').value) return;

    resEl.innerHTML = '<div class="media-loading">Loading Trending...</div>';
    
    // Simulate slight network delay for UI feedback
    setTimeout(() => {
      renderResults(getMediaSubset('', type), resEl, type);
      resEl.dataset.loaded = 'trending';
    }, 200);
  }

  async function searchMedia(query, type) {
    const resEl = type === 'stickers' ? document.getElementById('sticker-results') : document.getElementById('gif-results');
    if (!resEl) return;

    resEl.innerHTML = '<div class="media-loading">Searching...</div>';
    
    // Simulate slight network delay for UI feedback
    setTimeout(() => {
      renderResults(getMediaSubset(query, type), resEl, type);
      resEl.dataset.loaded = 'search';
    }, 200);
  }

  function renderResults(results, container, type) {
    container.innerHTML = '';
    if (!results || results.length === 0) {
      container.innerHTML = '<div class="media-error">No results</div>';
      return;
    }
    
    results.forEach(item => {
      const url = item.url;
      if (!url) return;

      const img = document.createElement('img');
      img.src = url;
      img.className = 'media-item';
      img.loading = 'lazy';
      img.onclick = () => {
        sendRichMedia(url, type === 'stickers' ? 'sticker' : 'gif');
        drawer.classList.remove('drawer-active');
      };
      container.appendChild(img);
    });
  }

  let emojiDataList = [];

  function renderEmojis(list) {
    const cont = document.getElementById('tab-emoji');
    if (!cont) return;
    cont.innerHTML = '';
    
    // Slice to 250 so DOM doesn't freeze
    list.slice(0, 250).forEach(em => {
      const c = em.char || em;
      const btn = document.createElement('div');
      btn.className   = 'emoji-item';
      btn.textContent = c;
      btn.title       = em.name || '';
      btn.onclick = () => {
        const input = document.getElementById('msg-input');
        if (input) {
          input.value += c;
          input.dispatchEvent(new Event('input')); // Trigger resize
          input.focus();
        }
      };
      cont.appendChild(btn);
    });
  }

  async function loadEmojis() {
    const cont = document.getElementById('tab-emoji');
    if (!cont) return;
    cont.innerHTML = '<div class="media-loading">Loading Emojis...</div>';
    
    try {
      if (emojiDataList.length === 0) {
        const res = await fetch('https://unpkg.com/emoji.json@14.0.0/emoji.json');
        if (res.ok) {
          emojiDataList = await res.json();
        } else {
          throw new Error('Fetch failed');
        }
      }
      renderEmojis(emojiDataList);
    } catch (e) {
      console.warn('Emoji fetch failed:', e);
      emojiDataList = EMOJI_LIST.map(char => ({ char, name: 'unknown' }));
      renderEmojis(emojiDataList);
    }
  }

  window.searchEmojis = function(query) {
    const lq = query.toLowerCase();
    const searchable = emojiDataList.length > 0 ? emojiDataList : EMOJI_LIST.map(char => ({ char, name: 'unknown' }));
    const filtered = searchable.filter(em => (em.name || '').toLowerCase().includes(lq));
    renderEmojis(filtered);
  };
});

// sendRichMedia consolidated below.

function sendRichMedia(url, type) {
  const normalizedUrl = typeof normalizeMediaUrl === 'function' ? normalizeMediaUrl(url) : '';
  if (!normalizedUrl) {
    showToast('Blocked unsafe media content', 'error');
    return;
  }

  const msg = {
    type: 'rich_media',
    mediaType: type,
    url: normalizedUrl,
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
