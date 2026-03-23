'use strict';

// ══════════════════════════════════════════════
// RICH MEDIA — Emojis, Giphy GIFs, Stickers
// ══════════════════════════════════════════════

const EMOJI_LIST = [
  '😀','😂','🥺','😍','🥰','😎','😭','😊','😉','😘','😜','🤪','🤔','🙄','😏','😴','🤫','🤭',
  '❤️','🔥','✨','⭐','🌟','🌈','☁️','⚡','❄️','🌈','🌊','🎨','🎭','🎬','🎤','🎧','🎹','🎸',
  '👍','👎','👏','🙌','🙏','💪','🤝','✌️','🤞','🤟','🤘','🤙','🖐️','✋','🖖','👌','🤏','👉',
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦',
  '🍎','🍓','🍒','🍑','🍍','🥥','🥝','🍕','🍔','🍟','🌭','🍿','🍩','🍪','🎂','🍰','🍦','🍧',
  '🚗','🚕','🚙','🚌','🏎️','🚓','🚑','🚒','🚐','🚚','🚛','🚜','🛵','🏍️','🚲','🛴','🛹','🚨',
  '🚀','🛸','🚁','🛶','⛵','🚢','✈️','🛩️','🛰️','🪐','🌏','🌑','🌕','☀️','🌦️','⛈️','🌩️','🌋'
];

const GIPHY_API_KEY = 'dc6zaTOxFJmzC'; // Public beta key

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

  // Giphy Search (Shared for GIFs and Stickers)
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
        searchGiphy(q, activeTab === 'sticker' ? 'stickers' : 'gifs');
      }, 500);
    });
  }

  // ── Giphy Helpers ─────────────────────────────
  
  async function loadTrending(type) {
    const resEl = type === 'stickers' ? document.getElementById('sticker-results') : document.getElementById('gif-results');
    if (!resEl) return;
    if (resEl.dataset.loaded === 'trending' && !document.getElementById('media-search-input').value) return;

    resEl.innerHTML = '<div class="media-loading">Loading Trending...</div>';
    try {
      const resp = await fetch(`https://api.giphy.com/v1/${type}/trending?api_key=${GIPHY_API_KEY}&limit=12&rating=g`);
      if (!resp.ok) throw new Error('API Error');
      const json = await resp.json();
      renderResults(json.data, resEl, type);
      resEl.dataset.loaded = 'trending';
    } catch (e) {
      console.warn('Giphy Trending Error:', e);
      resEl.innerHTML = '<div class="media-error">Giphy service unavailable. Emojis are still working!</div>';
    }
  }

  async function searchGiphy(query, type) {
    const resEl = type === 'stickers' ? document.getElementById('sticker-results') : document.getElementById('gif-results');
    if (!resEl) return;

    resEl.innerHTML = '<div class="media-loading">Searching...</div>';
    try {
      const resp = await fetch(`https://api.giphy.com/v1/${type}/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=15&rating=g`);
      if (!resp.ok) throw new Error('API Error');
      const json = await resp.json();
      renderResults(json.data, resEl, type);
      resEl.dataset.loaded = 'search';
    } catch (e) {
      console.warn('Giphy Search Error:', e);
      resEl.innerHTML = '<div class="media-error">No results or service unavailable.</div>';
    }
  }

  function renderResults(data, container, type) {
    container.innerHTML = '';
    if (!data || data.length === 0) {
      container.innerHTML = '<div class="media-error">No results</div>';
      return;
    }
    
    data.forEach(item => {
      const img = document.createElement('img');
      img.src = item.images.fixed_width_small.url;
      img.className = 'media-item';
      img.loading = 'lazy';
      img.onclick = () => {
        sendRichMedia(item.images.fixed_height.url, type === 'stickers' ? 'sticker' : 'gif');
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
    ts: Date.now()
  };
  rememberMessage(msg);
  renderRichMediaMessage(msg, true);
  if (typeof broadcastOrRelay === 'function') broadcastOrRelay(msg);
}
