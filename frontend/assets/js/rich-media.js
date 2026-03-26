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
  
  const FALLBACK_GIFS = [
    { media_formats: { gif: { url: "https://media.tenor.com/2RoCBzvBKhAAAAAM/cat-typing.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/_H3e-fEa1M8AAAAM/cute-cat.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/t3VdZOf0oHAAAAAM/cat-yes.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/QW0zXj0XU3sAAAAM/cat-dance.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/xHq3n_60UAAAAAAM/cat-funny.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/PZcM_j6Gg3wAAAAM/cat-no.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/b9a3z2P6oAAAAAAM/ok-agreed.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/gK22a0q5x8MAAAAM/thumbs-up.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/-pA3b-EPEjYAAAAM/crying-sad.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/lM_L1M9f-vAAAAAM/wow-omg.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/JvC-r27jOlcAAAAM/angry-mad.gif" } } },
    { media_formats: { gif: { url: "https://media.tenor.com/Z4oR-R0-U78AAAAM/laughing-lol.gif" } } }
  ];

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
      console.warn('Tenor API Rate Limited/Invalid:', e);
      // Fast free fallback since user required a forever free service
      renderResults(FALLBACK_GIFS.sort(() => 0.5 - Math.random()), resEl, type);
      resEl.dataset.loaded = 'trending';
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
      console.warn('Tenor API Rate Limited/Invalid:', e);
      renderResults(FALLBACK_GIFS.sort(() => 0.5 - Math.random()), resEl, type);
      resEl.dataset.loaded = 'search';
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
