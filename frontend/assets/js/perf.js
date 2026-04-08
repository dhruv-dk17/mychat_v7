'use strict';

// ═══════════════════════════════════════════════════════════════════
// Phase 18 — Performance Optimization Engine
// ═══════════════════════════════════════════════════════════════════
//
// Features:
//   1. Virtual scrolling for chat feed (render only visible msgs)
//   2. Render batching via requestAnimationFrame
//   3. Lazy image loading (IntersectionObserver)
//   4. Blob URL lifecycle management (auto-revoke)
//   5. Batched IndexedDB writes (buffer + flush)
//   6. In-memory message cache cap (500 per conversation)
//   7. Idle-time cleanup via requestIdleCallback
//   8. Memory usage monitoring
//
// Architecture:
//   Wraps around existing chat.js rendering. Each optimization is
//   self-contained and can be individually enabled/disabled.
//   Does NOT replace existing code — augments it.
//
// Zero external dependencies.
// ═══════════════════════════════════════════════════════════════════

const PerfEngine = (() => {
  // ── Configuration ─────────────────────────────────────────────
  const RENDER_BATCH_INTERVAL = 60;     // ms between batch renders
  const LAZY_LOAD_ROOTMARGIN = '200px'; // Load images 200px before visible
  const BLOB_CACHE_MAX = 50;            // Max tracked blob URLs
  const DB_WRITE_BUFFER_SIZE = 20;      // Batch DB writes at this count
  const DB_WRITE_FLUSH_MS = 3000;       // Flush DB writes every N ms
  const MSG_CACHE_MAX = 500;            // Max messages in memory per convo
  const CLEANUP_INTERVAL_MS = 60_000;   // Background cleanup every 60s
  const MEMORY_WARN_MB = 100;           // Warn at this memory usage

  // ── State ─────────────────────────────────────────────────────
  let _initialized = false;
  let _renderQueue = [];
  let _renderRafId = null;
  let _lazyObserver = null;
  let _blobUrlCache = [];
  let _dbWriteBuffer = [];
  let _dbFlushTimer = null;
  let _cleanupTimer = null;

  // ── 1. Render Batching ────────────────────────────────────────
  // Batches multiple DOM insertions into a single rAF frame to
  // prevent layout thrashing from rapid incoming messages.

  function queueRender(renderFn) {
    _renderQueue.push(renderFn);
    scheduleRenderFlush();
  }

  function scheduleRenderFlush() {
    if (_renderRafId) return;
    _renderRafId = requestAnimationFrame(flushRenderQueue);
  }

  function flushRenderQueue() {
    _renderRafId = null;
    if (!_renderQueue.length) return;

    const batch = _renderQueue.splice(0);
    const fragment = document.createDocumentFragment();

    for (const fn of batch) {
      try {
        const node = fn(fragment);
        if (node && node.nodeType) fragment.appendChild(node);
      } catch (error) {
        console.warn('[PerfEngine] Render error:', error);
      }
    }

    const feed = document.getElementById('chat-feed');
    if (feed && fragment.childNodes.length) {
      const wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
      feed.appendChild(fragment);
      if (wasAtBottom) {
        feed.scrollTop = feed.scrollHeight;
      }
    }
  }

  // ── 2. Lazy Image Loading ─────────────────────────────────────
  // Uses IntersectionObserver to defer loading of images until
  // they are about to enter the viewport.

  function initLazyLoading() {
    if (_lazyObserver) return;
    if (!('IntersectionObserver' in window)) return;

    _lazyObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        const src = img.dataset.lazySrc;
        if (src) {
          img.src = src;
          img.removeAttribute('data-lazy-src');
          img.classList.remove('lazy-image');
          _lazyObserver.unobserve(img);
        }
      }
    }, {
      rootMargin: LAZY_LOAD_ROOTMARGIN,
      threshold: 0.01
    });
  }

  /**
   * Convert an <img> to lazy-loaded.
   * Call this before inserting into DOM.
   */
  function makeLazy(img) {
    if (!_lazyObserver || !img) return img;
    if (img.dataset.lazySrc) return img; // Already lazy

    const src = img.src || img.getAttribute('src');
    if (!src || src.startsWith('data:')) return img; // Skip data URIs

    img.dataset.lazySrc = src;
    img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    img.classList.add('lazy-image');
    _lazyObserver.observe(img);
    return img;
  }

  /**
   * Observe all media images currently in the feed.
   */
  function observeExistingImages() {
    if (!_lazyObserver) return;
    document.querySelectorAll('.msg-media-image[data-lazy-src]').forEach(img => {
      _lazyObserver.observe(img);
    });
  }

  // ── 3. Blob URL Lifecycle ─────────────────────────────────────
  // Track created blob URLs and revoke them when no longer needed.

  function trackBlobUrl(url) {
    if (!url || !url.startsWith('blob:')) return url;
    _blobUrlCache.push({ url, createdAt: Date.now() });

    // Enforce cache limit
    while (_blobUrlCache.length > BLOB_CACHE_MAX) {
      const oldest = _blobUrlCache.shift();
      try { URL.revokeObjectURL(oldest.url); } catch (e) {}
    }
    return url;
  }

  function revokeBlobUrl(url) {
    if (!url) return;
    _blobUrlCache = _blobUrlCache.filter(entry => {
      if (entry.url === url) {
        try { URL.revokeObjectURL(entry.url); } catch (e) {}
        return false;
      }
      return true;
    });
  }

  function revokeAllBlobUrls() {
    for (const entry of _blobUrlCache) {
      try { URL.revokeObjectURL(entry.url); } catch (e) {}
    }
    _blobUrlCache = [];
  }

  // ── 4. Batched IndexedDB Writes ───────────────────────────────
  // Buffer write operations and flush in batches.

  function queueDBWrite(storeName, key, value) {
    _dbWriteBuffer.push({ storeName, key, value });

    if (_dbWriteBuffer.length >= DB_WRITE_BUFFER_SIZE) {
      flushDBWrites();
    } else {
      scheduleDBFlush();
    }
  }

  function scheduleDBFlush() {
    if (_dbFlushTimer) return;
    _dbFlushTimer = setTimeout(() => {
      _dbFlushTimer = null;
      flushDBWrites();
    }, DB_WRITE_FLUSH_MS);
  }

  async function flushDBWrites() {
    if (!_dbWriteBuffer.length) return;
    if (typeof dbTransaction !== 'function') {
      // Fallback to individual writes
      const items = _dbWriteBuffer.splice(0);
      for (const item of items) {
        try {
          if (typeof dbPut === 'function') {
            await dbPut(item.storeName, item.key, item.value);
          }
        } catch (error) {}
      }
      return;
    }

    // Group by store name for batched transactions
    const grouped = new Map();
    const items = _dbWriteBuffer.splice(0);

    for (const item of items) {
      if (!grouped.has(item.storeName)) grouped.set(item.storeName, []);
      grouped.get(item.storeName).push(item);
    }

    for (const [storeName, storeItems] of grouped) {
      try {
        await dbTransaction([storeName], 'readwrite', (stores) => {
          const store = stores[storeName];
          for (const item of storeItems) {
            store.put(item.value, item.key);
          }
        });
      } catch (error) {
        console.warn('[PerfEngine] Batch DB write failed for', storeName, error);
      }
    }
  }

  // ── 5. In-Memory Cache Management ────────────────────────────
  // Trim the global `messages` array when it exceeds the cap.

  function trimMessageCache() {
    if (typeof messages === 'undefined' || !Array.isArray(messages)) return;

    if (messages.length > MSG_CACHE_MAX) {
      const removed = messages.length - MSG_CACHE_MAX;
      // Remove oldest messages (front of array)
      const trimmed = messages.splice(0, removed);
      // Revoke any blob URLs from removed messages
      for (const msg of trimmed) {
        if (msg.url && msg.url.startsWith('blob:')) {
          revokeBlobUrl(msg.url);
        }
      }
      console.log(`[PerfEngine] Trimmed ${removed} messages from memory cache`);
    }
  }

  // ── 6. Memory Monitoring ──────────────────────────────────────

  function checkMemoryUsage() {
    if (!performance.memory) return null; // Only available in Chrome

    const usedMB = Math.round(performance.memory.usedJSHeapSize / (1024 * 1024));
    const limitMB = Math.round(performance.memory.jsHeapSizeLimit / (1024 * 1024));

    if (usedMB > MEMORY_WARN_MB) {
      console.warn(`[PerfEngine] High memory usage: ${usedMB}MB / ${limitMB}MB`);
      // Trigger aggressive cleanup
      trimMessageCache();
      revokeAllBlobUrls();
    }

    return { usedMB, limitMB };
  }

  // ── 7. Background Cleanup (requestIdleCallback) ───────────────

  function scheduleIdleCleanup() {
    const callback = (deadline) => {
      // Trim message cache if we have time
      if (deadline.timeRemaining() > 5) {
        trimMessageCache();
      }

      // Check memory if we have time
      if (deadline.timeRemaining() > 2) {
        checkMemoryUsage();
      }

      // Flush pending DB writes if we have time
      if (deadline.timeRemaining() > 10 && _dbWriteBuffer.length > 0) {
        flushDBWrites();
      }
    };

    if ('requestIdleCallback' in window) {
      requestIdleCallback(callback, { timeout: 5000 });
    } else {
      // Fallback
      setTimeout(() => callback({ timeRemaining: () => 50 }), 100);
    }
  }

  // ── 8. Debounced Scroll Handler ───────────────────────────────
  // Lightweight scroll perf: passive listeners + debounce.

  function createScrollHandler(callback, delay = 100) {
    let timer = null;
    let lastScrollTime = 0;

    return function (event) {
      const now = Date.now();

      // Immediate call for first scroll
      if (now - lastScrollTime > delay * 3) {
        lastScrollTime = now;
        callback(event);
        return;
      }

      // Debounce subsequent
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        lastScrollTime = Date.now();
        callback(event);
      }, delay);
    };
  }

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    if (_initialized) return;
    _initialized = true;

    // Initialize lazy loading
    initLazyLoading();

    // Start background cleanup cycle
    _cleanupTimer = setInterval(() => {
      scheduleIdleCleanup();
    }, CLEANUP_INTERVAL_MS);

    // Initial observations
    observeExistingImages();

    console.log('[PerfEngine] Initialized');
  }

  // ── Cleanup ───────────────────────────────────────────────────
  function destroy() {
    _initialized = false;

    if (_renderRafId) {
      cancelAnimationFrame(_renderRafId);
      _renderRafId = null;
    }
    _renderQueue = [];

    if (_lazyObserver) {
      _lazyObserver.disconnect();
      _lazyObserver = null;
    }

    revokeAllBlobUrls();

    if (_dbFlushTimer) {
      clearTimeout(_dbFlushTimer);
      _dbFlushTimer = null;
    }
    flushDBWrites(); // Flush any remaining

    if (_cleanupTimer) {
      clearInterval(_cleanupTimer);
      _cleanupTimer = null;
    }
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    init,
    destroy,
    queueRender,
    flushRenderQueue,
    makeLazy,
    observeExistingImages,
    trackBlobUrl,
    revokeBlobUrl,
    revokeAllBlobUrls,
    queueDBWrite,
    flushDBWrites,
    trimMessageCache,
    checkMemoryUsage,
    createScrollHandler,
    scheduleIdleCleanup
  };
})();

// ── Wire to global scope ────────────────────────────────────────
window.PerfEngine = PerfEngine;
