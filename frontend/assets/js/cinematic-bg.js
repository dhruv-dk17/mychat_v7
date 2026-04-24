/**
 * cinematic-bg.js - Custom fading logic for background video
 */

function initCinematicBackground() {
    const video = document.getElementById('bg-video');
    if (!video) return;

    let fadeAnimationId = null;
    let isFadingOut = false;

    const fade = (targetOpacity, duration, callback) => {
        if (fadeAnimationId) cancelAnimationFrame(fadeAnimationId);
        
        const startOpacity = parseFloat(window.getComputedStyle(video).opacity) || 0;
        const startTime = performance.now();

        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Linear interpolation
            const currentOpacity = startOpacity + (targetOpacity - startOpacity) * progress;
            video.style.opacity = currentOpacity;

            if (progress < 1) {
                fadeAnimationId = requestAnimationFrame(animate);
            } else if (callback) {
                callback();
            }
        };

        fadeAnimationId = requestAnimationFrame(animate);
    };

    const handleLoop = () => {
        isFadingOut = true;
        fade(0, 500, () => {
            // Wait 100ms as per spec
            setTimeout(() => {
                video.currentTime = 0;
                video.play();
                isFadingOut = false;
                fade(1, 500);
            }, 100);
        });
    };

    video.addEventListener('timeupdate', () => {
        // If 0.55 seconds remain and we aren't already fading out
        if (!isFadingOut && (video.duration - video.currentTime) <= 0.55) {
            handleLoop();
        }
    });

    // Handle the case where video ends before timeupdate catches it
    video.addEventListener('ended', () => {
        if (!isFadingOut) {
            handleLoop();
        }
    });

    // Initial fade in
    const startVideo = () => {
        if (video.paused && !isFadingOut) {
            video.play().catch(e => console.warn("Video autoplay blocked or failed:", e));
            fade(1, 500);
        }
    };

    if (video.readyState >= 3) {
        startVideo();
    } else {
        video.addEventListener('canplay', startVideo, { once: true });
    }

    // Error handling
    video.addEventListener('error', (e) => {
        console.error("Background video failed to load:", e);
        // Fallback: minimal visibility or alternative
        document.body.style.background = "#0a0a0b";
    });
}

document.addEventListener('DOMContentLoaded', initCinematicBackground);
