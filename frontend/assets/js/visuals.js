// visuals.js - Background effects management
'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // We have moved to a cinematic video background (cinematic-bg.js).
  // The old canvas animation is disabled to optimize performance.
  const canvas = document.getElementById('visual-canvas-layer');
  if (canvas) {
    canvas.style.display = 'none';
  }
});
