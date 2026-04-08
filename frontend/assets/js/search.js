'use strict';

// ═══════════════════════════════════════════════════════════════════
// Phase 15 — Search & Discovery Engine
// ═══════════════════════════════════════════════════════════════════
//
// Unified search across:
//   1. In-memory messages (current session)
//   2. IndexedDB stored conversations (historical)
//   3. Contacts
//
// Design: Non-blocking, debounced, ranked results with highlighting.
// Zero external dependencies. All DOM-safe escaping through existing
// `escHtml` utility.
// ═══════════════════════════════════════════════════════════════════

const SearchEngine = (() => {
  // ── Configuration ─────────────────────────────────────────────
  const MIN_QUERY_LENGTH = 2;
  const DEBOUNCE_MS = 180;
  const MAX_RESULTS = 100;
  const STORED_SEARCH_BATCH = 200;
  const CONTEXT_CHARS = 60;

  // ── State ─────────────────────────────────────────────────────
  let _searchPanelVisible = false;
  let _currentQuery = '';
  let _debounceTimer = null;
  let _lastSearchId = 0;
  let _resultCache = [];
  let _currentResultIndex = -1;
  let _globalSearchPanel = null;
  let _onNavigateToResult = null;

  // ── Scoring ───────────────────────────────────────────────────
  function scoreResult(text, query) {
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    let score = 0;

    // Exact match bonus
    if (lower === q) score += 100;
    // Starts-with bonus
    else if (lower.startsWith(q)) score += 60;
    // Word-boundary match
    else if (new RegExp(`\\b${escapeRegex(q)}`).test(lower)) score += 40;
    // Substring match
    else if (lower.includes(q)) score += 20;

    return score;
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // ── In-memory search (current session messages) ───────────────
  function searchInMemory(query) {
    if (typeof messages === 'undefined' || !Array.isArray(messages)) return [];

    const q = query.toLowerCase();
    const results = [];

    for (const msg of messages) {
      if (!msg || msg.isDeleted) continue;
      const text = String(msg.text || msg.content || '');
      const from = String(msg.from || '');
      const combined = `${text} ${from}`;

      if (!combined.toLowerCase().includes(q)) continue;

      results.push({
        source: 'memory',
        id: msg.id,
        type: msg.type || 'msg',
        text,
        from,
        ts: msg.ts || 0,
        conversationId: msg.conversationId || '',
        roomId: msg.roomId || '',
        score: scoreResult(text, query) + (text.toLowerCase().includes(q) ? 10 : 0),
        message: msg
      });
    }

    return results;
  }

  // ── IndexedDB search (stored conversations) ───────────────────
  async function searchStoredMessages(query, searchId) {
    if (typeof searchStoredConversations !== 'function') return [];

    try {
      const rows = await searchStoredConversations(query, MAX_RESULTS);
      if (searchId !== _lastSearchId) return []; // Stale

      return rows.map(row => ({
        source: 'stored',
        id: row.id,
        type: row.type || 'msg',
        text: String(row.text || row.content || ''),
        from: String(row.from || ''),
        ts: row.ts || 0,
        conversationId: row.conversationId || '',
        roomId: row.roomId || '',
        score: scoreResult(String(row.text || row.content || ''), query),
        message: row
      }));
    } catch (error) {
      console.warn('Stored message search failed', error);
      return [];
    }
  }

  // ── Contact search ────────────────────────────────────────────
  async function searchContactEntries(query) {
    if (typeof searchContacts !== 'function') return [];

    try {
      const contacts = await searchContacts(query);
      return contacts.map(contact => ({
        source: 'contact',
        id: contact.fingerprint,
        type: 'contact',
        text: contact.displayName || contact.fingerprint,
        from: contact.fingerprint,
        ts: contact.lastSeen || contact.addedAt || 0,
        conversationId: '',
        roomId: '',
        score: scoreResult(String(contact.displayName || ''), query) + 5,
        contact
      }));
    } catch (error) {
      console.warn('Contact search failed', error);
      return [];
    }
  }

  // ── Unified search ────────────────────────────────────────────
  async function unifiedSearch(query) {
    if (!query || query.length < MIN_QUERY_LENGTH) {
      _resultCache = [];
      _currentResultIndex = -1;
      return [];
    }

    const searchId = ++_lastSearchId;
    const q = query.trim();

    // Run all searches in parallel
    const [memoryResults, storedResults, contactResults] = await Promise.all([
      Promise.resolve(searchInMemory(q)),
      searchStoredMessages(q, searchId),
      searchContactEntries(q)
    ]);

    if (searchId !== _lastSearchId) return _resultCache; // Outdated

    // Deduplicate: memory results take priority over stored
    const seenIds = new Set();
    const merged = [];

    for (const result of memoryResults) {
      if (result.id && !seenIds.has(result.id)) {
        seenIds.add(result.id);
        merged.push(result);
      }
    }

    for (const result of storedResults) {
      if (result.id && !seenIds.has(result.id)) {
        seenIds.add(result.id);
        merged.push(result);
      }
    }

    for (const result of contactResults) {
      if (result.id && !seenIds.has(result.id)) {
        seenIds.add(result.id);
        merged.push(result);
      }
    }

    // Sort by score (desc), then by recency (desc)
    merged.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.ts || 0) - (a.ts || 0);
    });

    _resultCache = merged.slice(0, MAX_RESULTS);
    _currentResultIndex = -1;
    return _resultCache;
  }

  // ── Highlight helper ──────────────────────────────────────────
  function highlightText(text, query) {
    if (!text || !query) return typeof escHtml === 'function' ? escHtml(text) : text;
    const escaped = typeof escHtml === 'function' ? escHtml(text) : text;
    const escapedQuery = typeof escHtml === 'function' ? escHtml(query) : query;
    const regex = new RegExp(`(${escapeRegex(escapedQuery)})`, 'gi');
    return escaped.replace(regex, '<mark class="search-highlight">$1</mark>');
  }

  // ── Context snippet ───────────────────────────────────────────
  function getContextSnippet(text, query) {
    if (!text || !query) return '';
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return text.slice(0, CONTEXT_CHARS * 2);
    const start = Math.max(0, idx - CONTEXT_CHARS);
    const end = Math.min(text.length, idx + query.length + CONTEXT_CHARS);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet += '…';
    return snippet;
  }

  // ── UI: Build search panel ────────────────────────────────────
  function createSearchPanel() {
    if (_globalSearchPanel) return _globalSearchPanel;

    const panel = document.createElement('div');
    panel.id = 'global-search-panel';
    panel.className = 'global-search-panel';
    panel.setAttribute('role', 'search');
    panel.setAttribute('aria-label', 'Search messages and contacts');
    panel.innerHTML = `
      <div class="gs-header">
        <div class="gs-input-wrap">
          <svg class="gs-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input type="search" id="gs-search-input" class="gs-input" placeholder="Search messages, contacts…"
                 autocomplete="off" spellcheck="false" aria-label="Search query" />
          <button class="gs-close-btn" id="gs-close-btn" type="button" aria-label="Close search">✕</button>
        </div>
        <div class="gs-nav" id="gs-nav" hidden>
          <span class="gs-result-count" id="gs-result-count">0 results</span>
          <button class="gs-nav-btn" id="gs-prev-btn" type="button" aria-label="Previous result">▲</button>
          <button class="gs-nav-btn" id="gs-next-btn" type="button" aria-label="Next result">▼</button>
        </div>
      </div>
      <div class="gs-results" id="gs-results" role="listbox" aria-label="Search results"></div>
      <div class="gs-empty" id="gs-empty" hidden>
        <span class="gs-empty-icon">🔍</span>
        <span class="gs-empty-text">No results found</span>
      </div>
      <div class="gs-loading" id="gs-loading" hidden>
        <div class="loading-spinner gs-spinner"></div>
        <span>Searching…</span>
      </div>
    `;

    _globalSearchPanel = panel;
    return panel;
  }

  // ── UI: Render results ────────────────────────────────────────
  function renderResults(results, query) {
    const container = document.getElementById('gs-results');
    const emptyEl = document.getElementById('gs-empty');
    const navEl = document.getElementById('gs-nav');
    const countEl = document.getElementById('gs-result-count');
    const loadingEl = document.getElementById('gs-loading');

    if (loadingEl) loadingEl.hidden = true;

    if (!container) return;
    container.replaceChildren();

    if (!results.length) {
      if (emptyEl) emptyEl.hidden = !query || query.length < MIN_QUERY_LENGTH ? true : false;
      if (navEl) navEl.hidden = true;
      return;
    }

    if (emptyEl) emptyEl.hidden = true;
    if (navEl) navEl.hidden = false;
    if (countEl) countEl.textContent = `${results.length} result${results.length !== 1 ? 's' : ''}`;

    results.forEach((result, index) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'gs-result-item';
      el.setAttribute('role', 'option');
      el.dataset.resultIndex = String(index);
      el.dataset.resultId = result.id || '';

      const snippet = getContextSnippet(result.text, query);
      const highlighted = highlightText(snippet, query);
      const timeStr = result.ts ? fmtTime(result.ts) : '';
      const dateStr = result.ts ? new Date(result.ts).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
      const icon = document.createElement('div');
      icon.className = 'gs-result-icon';
      const body = document.createElement('div');
      body.className = 'gs-result-body';
      const from = document.createElement('div');
      from.className = 'gs-result-from';
      const snippetEl = document.createElement('div');
      snippetEl.className = 'gs-result-snippet';
      const meta = document.createElement('div');
      meta.className = 'gs-result-meta';

      if (result.type === 'contact') {
        el.innerHTML = `
          <div class="gs-result-icon">👤</div>
          <div class="gs-result-body">
            <div class="gs-result-from">${highlightText(result.text, query)}</div>
            <div class="gs-result-snippet">${typeof escHtml === 'function' ? escHtml(result.from) : result.from}</div>
          </div>
          <div class="gs-result-meta">
            <span class="gs-result-badge gs-badge-contact">Contact</span>
          </div>
        `;
      } else {
        const sourceIcon = result.source === 'stored' ? '💾' : '💬';
        el.innerHTML = `
          <div class="gs-result-icon">${sourceIcon}</div>
          <div class="gs-result-body">
            <div class="gs-result-from">${typeof escHtml === 'function' ? escHtml(result.from) : result.from}</div>
            <div class="gs-result-snippet">${highlighted}</div>
          </div>
          <div class="gs-result-meta">
            <span class="gs-result-time">${dateStr} ${timeStr}</span>
            <span class="gs-result-badge gs-badge-${result.source}">${result.source === 'stored' ? 'History' : 'Live'}</span>
          </div>
        `;
      }

      el.addEventListener('click', () => navigateToResult(index));
      container.appendChild(el);
    });
  }

  // ── Navigation ────────────────────────────────────────────────
  function navigateToResult(index) {
    if (index < 0 || index >= _resultCache.length) return;

    // Remove previous highlight
    if (_currentResultIndex >= 0) {
      const prev = document.querySelector(`.gs-result-item[data-result-index="${_currentResultIndex}"]`);
      if (prev) prev.classList.remove('gs-result-active');
    }

    _currentResultIndex = index;
    const result = _resultCache[index];
    if (!result) return;

    // Highlight current result in panel
    const el = document.querySelector(`.gs-result-item[data-result-index="${index}"]`);
    if (el) {
      el.classList.add('gs-result-active');
      el.scrollIntoView({ block: 'nearest' });
    }

    // Navigate to message in chat feed
    if (result.id && result.type !== 'contact') {
      const msgEl = document.querySelector(`[data-msg-id="${result.id}"]`);
      if (msgEl) {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msgEl.classList.add('msg-flash');
        setTimeout(() => msgEl.classList.remove('msg-flash'), 1500);
      }
    }

    // Fire custom callback
    if (typeof _onNavigateToResult === 'function') {
      _onNavigateToResult(result);
    }
  }

  function navigateNext() {
    if (!_resultCache.length) return;
    navigateToResult((_currentResultIndex + 1) % _resultCache.length);
  }

  function navigatePrev() {
    if (!_resultCache.length) return;
    navigateToResult(_currentResultIndex <= 0 ? _resultCache.length - 1 : _currentResultIndex - 1);
  }

  // ── Debounced search execution ────────────────────────────────
  function executeSearch(query) {
    _currentQuery = query;
    if (_debounceTimer) clearTimeout(_debounceTimer);

    if (!query || query.length < MIN_QUERY_LENGTH) {
      renderResults([], '');
      // Also clear in-feed highlights
      if (typeof searchMessages === 'function') searchMessages('');
      return;
    }

    const loadingEl = document.getElementById('gs-loading');
    if (loadingEl) loadingEl.hidden = false;

    _debounceTimer = setTimeout(async () => {
      const results = await unifiedSearch(query);
      renderResults(results, query);

      // Also highlight in the current chat feed
      if (typeof searchMessages === 'function') searchMessages(query);
    }, DEBOUNCE_MS);
  }

  // ── Panel visibility ──────────────────────────────────────────
  function show() {
    if (!_globalSearchPanel) return;
    _globalSearchPanel.classList.add('gs-visible');
    _searchPanelVisible = true;
    const input = document.getElementById('gs-search-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function hide() {
    if (!_globalSearchPanel) return;
    _globalSearchPanel.classList.remove('gs-visible');
    _searchPanelVisible = false;
    _currentQuery = '';
    _resultCache = [];
    _currentResultIndex = -1;
    const input = document.getElementById('gs-search-input');
    if (input) input.value = '';
    renderResults([], '');
    if (typeof searchMessages === 'function') searchMessages('');
  }

  function toggle() {
    if (_searchPanelVisible) hide();
    else show();
  }

  function isVisible() {
    return _searchPanelVisible;
  }

  // ── Init: Mount panel + bind events ───────────────────────────
  function init(options = {}) {
    const panel = createSearchPanel();
    _onNavigateToResult = options.onNavigate || null;

    // Mount the panel
    const chatMain = document.getElementById('chat-main') || document.getElementById('chat-feed')?.parentElement;
    if (chatMain && !document.getElementById('global-search-panel')) {
      chatMain.insertBefore(panel, chatMain.firstChild);
    }

    // Bind input
    const input = document.getElementById('gs-search-input');
    if (input) {
      input.addEventListener('input', () => executeSearch(input.value.trim()));
      input.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          hide();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          if (event.shiftKey) navigatePrev();
          else navigateNext();
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          navigateNext();
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          navigatePrev();
        }
      });
    }

    // Close button
    document.getElementById('gs-close-btn')?.addEventListener('click', hide);

    // Nav buttons
    document.getElementById('gs-prev-btn')?.addEventListener('click', navigatePrev);
    document.getElementById('gs-next-btn')?.addEventListener('click', navigateNext);

    // Global keyboard shortcut: Ctrl+F / Cmd+F
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        if (document.body.dataset.page === 'chat') {
          event.preventDefault();
          toggle();
        }
      }
    });
  }

  // ── Public API ────────────────────────────────────────────────
  return {
    init,
    show,
    hide,
    toggle,
    isVisible,
    search: unifiedSearch,
    navigateNext,
    navigatePrev,
    getResults: () => [..._resultCache],
    getCurrentIndex: () => _currentResultIndex
  };
})();

// ── IndexedDB search helper (bridges to chat-store.js) ──────────
// chat-store.js stores messages with AES-GCM encrypted content.
// We MUST use its searchStoredMessages() which decrypts-then-matches,
// rather than searching raw ciphertext in IndexedDB directly.

async function searchStoredConversations(query, limit = 100) {
  if (!query) return [];

  // Primary path: use chat-store's decrypt-aware search
  if (typeof window.searchStoredMessages === 'function') {
    try {
      const results = await window.searchStoredMessages(query);
      return results.slice(0, limit);
    } catch (error) {
      console.warn('searchStoredMessages failed', error);
      return [];
    }
  }

  // No chat-store search available — cannot search encrypted data
  return [];
}

// ── Wire to global scope ────────────────────────────────────────
window.SearchEngine = SearchEngine;
window.searchStoredConversations = searchStoredConversations;
