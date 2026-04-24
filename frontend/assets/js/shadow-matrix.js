/**
 * Shadow Matrix Protocol - Advanced Anti-Surveillance
 * Hooks into index.html and chat.html
 */

(function initShadowMatrix() {
  if (typeof window === 'undefined') return;

  // 1. Panic Button (Triple ESC)
  let escCount = 0;
  let escTimer = null;
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      escCount++;
      if (escCount >= 3) {
        // Trigger Panic!
        localStorage.clear();
        sessionStorage.clear();
        document.body.innerHTML = '';
        window.location.replace('https://en.wikipedia.org/wiki/Special:Random');
      }
      clearTimeout(escTimer);
      escTimer = setTimeout(() => { escCount = 0; }, 1000);
    }
  });

  // 2. Idle Blur (Shoulder-surfing protection)
  let idleTimer = null;
  const idleTimeout = 30000; // 30 seconds
  function resetIdle() {
    if (document.body.classList.contains('shadow-idle-blur')) {
      document.body.classList.remove('shadow-idle-blur');
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      document.body.classList.add('shadow-idle-blur');
    }, idleTimeout);
  }
  
  window.addEventListener('mousemove', resetIdle);
  window.addEventListener('keydown', resetIdle);
  window.addEventListener('click', resetIdle);
  window.addEventListener('scroll', resetIdle);
  resetIdle();

  // 3. Boss Mode Camouflage (Ctrl + /)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === '/') {
      document.body.classList.toggle('shadow-boss-mode');
    }
  });

})();

// CSS Injections for Stealth Features
const shadowStyle = document.createElement('style');
shadowStyle.textContent = `
  .shadow-idle-blur {
    transition: filter 0.5s ease-out;
    filter: blur(15px) grayscale(100%);
    pointer-events: none;
  }
  .shadow-boss-mode {
    background: #ffffff !important;
    color: #000000 !important;
    font-family: 'Courier New', Courier, monospace !important;
  }
  .shadow-boss-mode * {
    background: transparent !important;
    color: #000000 !important;
    border-color: #dddddd !important;
    box-shadow: none !important;
    text-shadow: none !important;
    background-image: none !important;
  }
  .shadow-boss-mode canvas {
    display: none !important;
  }
  .shadow-boss-mode img, .shadow-boss-mode video {
    display: none !important;
  }
`;
document.head.appendChild(shadowStyle);
