'use strict';

// ── State ─────────────────────────────────────────────────────────
let screenshotStrikes  = 0;
let devToolsOpen       = false;
let blurShieldActive   = false;
const destructTimers   = new Map();

// ════════════════════════════════════════════
// 1. BLUR SHIELD
// ════════════════════════════════════════════

function activateBlurShield(reason) {
  if (blurShieldActive) return;
  blurShieldActive = true;
  const el     = document.getElementById('blur-shield');
  const reason_el = document.getElementById('blur-reason');
  if (!el) return;
  if (reason_el && reason) reason_el.textContent = reason;
  el.classList.add('shield-visible');
}

function deactivateBlurShield() {
  blurShieldActive = false;
  const el = document.getElementById('blur-shield');
  if (el) el.classList.remove('shield-visible');
}

document.addEventListener('visibilitychange', () => {
  document.hidden ? activateBlurShield('Tab switched') : deactivateBlurShield();
});
window.addEventListener('blur',  () => activateBlurShield('Window lost focus'));
window.addEventListener('focus', deactivateBlurShield);

// Tap to dismiss on mobile
document.addEventListener('DOMContentLoaded', () => {
  const shield = document.getElementById('blur-shield');
  if (shield) {
    shield.addEventListener('click', deactivateBlurShield);
  }
});

// ════════════════════════════════════════════
// 2. SCREENSHOT KEY DETECTION
// ════════════════════════════════════════════

const SCREENSHOT_COMBOS = [
  e => e.key === 'PrintScreen',
  e => e.altKey  && e.key === 'PrintScreen',
  e => e.metaKey && e.shiftKey && e.key === '3',
  e => e.metaKey && e.shiftKey && e.key === '4',
  e => e.metaKey && e.shiftKey && e.key === '5',
  e => e.metaKey && e.ctrlKey  && e.shiftKey && e.key === '4',
  e => e.metaKey && e.shiftKey && e.key === 's',
  e => e.ctrlKey && e.key === 'PrintScreen',
  e => e.key === 'F13',
];

document.addEventListener('keydown', e => {
  if (SCREENSHOT_COMBOS.some(fn => fn(e))) {
    e.preventDefault();
    onScreenshotAttemptDetected();
  }
});

function onScreenshotAttemptDetected() {
  activateBlurShield('Screenshot blocked');
  screenshotStrikes++;
  setShieldIndicator(screenshotStrikes >= CONFIG.MAX_SCREENSHOT_STRIKES ? 'red' : 'amber');
  showToast(`⚠ Screenshot attempt blocked (${screenshotStrikes}/${CONFIG.MAX_SCREENSHOT_STRIKES})`, 'danger');
  try { broadcastToPeers({ type: 'screenshot_attempt', from: myUsername, ts: Date.now() }); } catch (e) {}
  if (screenshotStrikes >= CONFIG.MAX_SCREENSHOT_STRIKES) triggerEmergencyWipe();
}

function onPeerScreenshotAttempt(fromUsername) {
  addSystemMessage(`⚠ ${fromUsername} attempted to screenshot`);
  showScreenshotBanner(fromUsername);
  setShieldIndicator('red');
}

function onPeerDevTools(fromUsername) {
  addSystemMessage(`⚠ ${fromUsername} opened developer tools`);
  setShieldIndicator('red');
}

// ════════════════════════════════════════════
// 3. CSS ANTI-CAPTURE → anti-surveillance.css
// ════════════════════════════════════════════
// (handled in CSS only)

// ════════════════════════════════════════════
// 4. DEVTOOLS DETECTION
// ════════════════════════════════════════════

setInterval(() => {
  const open = (window.outerWidth  - window.innerWidth  > 160) ||
               (window.outerHeight - window.innerHeight > 160);
  if (open && !devToolsOpen) {
    devToolsOpen = true;
    activateBlurShield('Developer tools detected');
    showToast('⚠ DevTools detected — chat hidden from screen', 'danger');
    try { broadcastToPeers({ type: 'devtools_detected', from: myUsername, ts: Date.now() }); } catch (e) {}
  } else if (!open && devToolsOpen) {
    devToolsOpen = false;
    deactivateBlurShield();
  }
}, 2000);

// ════════════════════════════════════════════
// 5. SCREEN CAPTURE API OVERRIDE
// ════════════════════════════════════════════

if (navigator.mediaDevices?.getDisplayMedia) {
  const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getDisplayMedia = async function (opts) {
    onScreenshotAttemptDetected();
    throw new DOMException('Screen capture blocked by Mychat v7', 'NotAllowedError');
  };
}

// ════════════════════════════════════════════
// 6. MOUSE LEAVE DETECTION
// ════════════════════════════════════════════

document.addEventListener('mouseleave', e => {
  if (e.clientY <= 0 || e.clientX <= 0 ||
      e.clientX >= window.innerWidth || e.clientY >= window.innerHeight) {
    activateBlurShield('Cursor left window');
  }
});
document.addEventListener('mouseenter', deactivateBlurShield);

// ════════════════════════════════════════════
// 7. COPY / RIGHT-CLICK DISABLE IN CHAT FEED
// ════════════════════════════════════════════

function initChatProtection(el) {
  if (!el) return;
  el.addEventListener('contextmenu', e => e.preventDefault());
  el.addEventListener('dragstart',   e => e.preventDefault());
  el.addEventListener('keydown',     e => {
    if ((e.ctrlKey || e.metaKey) && ['c','C','a','A','x','X'].includes(e.key)) {
      e.preventDefault();
    }
  });
}

// ════════════════════════════════════════════
// 8. PRINT BLOCK
// ════════════════════════════════════════════

window.addEventListener('beforeprint', e => {
  e.preventDefault();
  activateBlurShield('Print attempt blocked');
  showToast('Printing is disabled in Mychat v7', 'danger');
});

// ════════════════════════════════════════════
// 9. SELF-DESTRUCTING MESSAGES
// ════════════════════════════════════════════

function setMessageTimer(messageId, seconds, isOwn = true) {
  clearTimeout(destructTimers.get(messageId));
  const t = setTimeout(() => {
    if (isOwn && typeof sendDeleteMessage === 'function') sendDeleteMessage(messageId);
    else if (typeof deleteMessage === 'function') deleteMessage(messageId);
    destructTimers.delete(messageId);
  }, seconds * 1000);
  destructTimers.set(messageId, t);

  // Show countdown label
  const el = document.querySelector(`[data-msg-id="${messageId}"] .msg-time`);
  if (el) {
    let rem = seconds;
    const iv = setInterval(() => {
      rem--;
      if (el.isConnected) el.textContent = `⏱ ${rem}s`;
      else clearInterval(iv);
      if (rem <= 0) clearInterval(iv);
    }, 1000);
  }
}

function showTimerModal(messageId) {
  const modal = document.getElementById('timer-modal');
  if (!modal) return;
  modal.dataset.targetMsg = messageId;
  showModal('timer-modal');
}

// ════════════════════════════════════════════
// 10. EMERGENCY AUTO-WIPE
// ════════════════════════════════════════════

function triggerEmergencyWipe() {
  showToast('🚨 Emergency wipe triggered — session destroyed', 'danger');
  stopAllMediaStreams();
  destroyPeer();

  messages.forEach(m => { if (m.blobUrl) URL.revokeObjectURL(m.blobUrl); });
  messages = [];
  const feed = document.getElementById('chat-feed');
  if (feed) feed.innerHTML = '';

  document.querySelectorAll('input, textarea').forEach(el => { el.value = ''; });
  sessionStorage.clear();
  destructTimers.forEach(t => clearTimeout(t));
  destructTimers.clear();

  const ws = document.getElementById('wipe-screen');
  if (ws) ws.classList.add('wipe-visible');

  setTimeout(navigateHome, 2500);
}

// ── Shield indicator ──────────────────────────────────────────────
function setShieldIndicator(color) {
  const dot = document.querySelector('.shield-dot');
  if (!dot) return;
  dot.className = 'shield-dot shield-' + color;
}

function updateShieldUI() {
  if (screenshotStrikes >= CONFIG.MAX_SCREENSHOT_STRIKES) setShieldIndicator('red');
  else if (screenshotStrikes > 0 || devToolsOpen)         setShieldIndicator('amber');
  else                                                     setShieldIndicator('green');
}

// ── Screenshot banner ────────────────────────────────────────────
function showScreenshotBanner(username) {
  const feed = document.getElementById('chat-feed');
  if (!feed) return;
  const b = document.createElement('div');
  b.className = 'screenshot-banner';
  b.innerHTML = `<span>⚠ <strong>${escHtml(username)}</strong> attempted to capture the screen — all members notified</span>
    <button onclick="this.parentElement.remove()">✕</button>`;
  feed.prepend(b);
  setTimeout(() => b.remove(), 8000);
}
