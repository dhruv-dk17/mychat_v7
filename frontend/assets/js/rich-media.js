'use strict';

const EMOJI_LIST = [
  '😀','😂','🥺','😍','🥰','😎','😭','😊','😉','😘','😜','🤪','🤔','🙄','😏','😴','😷','🤢',
  '❤️','🔥','✨','👍','👎','👏','🙌','🙏','💪','🎂','🎉','🎈','💯','✅','❌','⚠️','🤔',
  '☕','🍕','🍔','🍟','🍺','🥂','🍎','🍓','🍉','🐶','🐱','🐭','🐰','🐻','🐼','🐨','🐯',
  '🚗','🚕','🚙','🚌','🚓','🚑','🚒','🚜','🚲','🛴','🛵','🏍','🚨','🚀','🛸','🚁','🛶'
];

const STICKER_LIST = [
  'https://media2.giphy.com/media/l41lOclFq9T1A1BBu/200.gif', // example cat
  'https://media0.giphy.com/media/JIX9t2j0ZTN9S/200.gif',
  'https://media1.giphy.com/media/ICOgUNjpvO0PC/200.gif',
  'https://media2.giphy.com/media/VbnUQpnihPSIgIXuZv/200.gif',
  'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExemkzbmtnaTgwNHI0eWRmZXJxcHA4aXp5YWlzcndocXdzMTMzNzE2ZSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/MDJ9IbxxvDUQM/giphy.gif'
];

document.addEventListener('DOMContentLoaded', () => {
  const drawerBtn = document.getElementById('media-drawer-btn');
  const drawer    = document.getElementById('media-drawer');
  if (!drawerBtn || !drawer) return;

  // Toggle drawer
  drawerBtn.addEventListener('click', () => {
    const isVisible = drawer.style.display !== 'none';
    drawer.style.display = isVisible ? 'none' : 'flex';
    if (!isVisible && document.getElementById('tab-emoji').children.length === 0) {
      loadEmojis();
    }
  });

  // Close when clicking outside
  document.addEventListener('click', e => {
    if (drawer.style.display === 'flex' && !drawer.contains(e.target) && e.target !== drawerBtn) {
      drawer.style.display = 'none';
    }
  });

  // Tabs
  document.querySelectorAll('.media-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.media-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.media-tab-content').forEach(c => c.style.display = 'none');
      btn.classList.add('active');
      const target = btn.dataset.tab;
      document.getElementById('tab-' + target).style.display = target === 'emoji' ? 'grid' : 'flex';
      
      if (target === 'sticker' && document.getElementById('sticker-results').children.length === 0) {
        loadStickers();
      }
    });
  });

  // Giphy Search (Requires API key, using a public beta key for demo. Replace with real key.)
  const GIPHY_API_KEY = 'dc6zaTOxFJmzC'; 
  const searchInput = document.getElementById('gif-search');
  let gifTimer = null;
  
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      clearTimeout(gifTimer);
      const q = e.target.value.trim();
      if (!q) { document.getElementById('gif-results').innerHTML = ''; return; }
      gifTimer = setTimeout(() => searchGiphy(q), 500);
    });
  }

  async function searchGiphy(query) {
    const resEl = document.getElementById('gif-results');
    resEl.innerHTML = '<center>Loading...</center>';
    try {
      const resp = await fetch(`https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=12&rating=g`);
      const json = await resp.json();
      resEl.innerHTML = '';
      json.data.forEach(gif => {
        const img = document.createElement('img');
        img.src = gif.images.fixed_width_small.url;
        img.style.width = '100%';
        img.style.borderRadius = '8px';
        img.style.cursor = 'pointer';
        img.onclick = () => {
          sendRichMedia(gif.images.fixed_height.url, 'gif');
          drawer.style.display = 'none';
        };
        resEl.appendChild(img);
      });
    } catch (e) {
      resEl.innerHTML = '<center>Error loading GIFs</center>';
    }
  }

  function loadEmojis() {
    const cont = document.getElementById('tab-emoji');
    EMOJI_LIST.forEach(em => {
      const btn = document.createElement('div');
      btn.textContent = em;
      btn.style.fontSize = '24px';
      btn.style.cursor = 'pointer';
      btn.style.textAlign = 'center';
      btn.style.padding = '5px';
      btn.style.borderRadius = 'var(--r-sm)';
      
      btn.onmouseover = () => btn.style.background = 'rgba(255,255,255,0.1)';
      btn.onmouseout  = () => btn.style.background = 'transparent';
      
      btn.onclick = () => {
        const input = document.getElementById('msg-input');
        input.value += em;
        input.focus();
      };
      cont.appendChild(btn);
    });
  }

  function loadStickers() {
    const cont = document.getElementById('sticker-results');
    STICKER_LIST.forEach(url => {
      const img = document.createElement('img');
      img.src = url;
      img.style.width = '100%';
      img.style.borderRadius = '8px';
      img.style.cursor = 'pointer';
      img.onclick = () => {
        sendRichMedia(url, 'sticker');
        drawer.style.display = 'none';
      };
      cont.appendChild(img);
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
  messages.push(msg);
  renderRichMediaMessage(msg, true);
  if (typeof broadcastOrRelay === 'function') broadcastOrRelay(msg);
}
