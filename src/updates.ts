// Behavior for the updates index and the update detail pages. Loaded only on
// those pages (see the area check in layout/theme.liquid).

import { setupCommentCounts, setupCommentThread } from "./comments";
import { capturePointer, setupTimeline } from "./timeline";

/**
 * Reveal "Read more" only on cards whose body is actually cut off. The markup
 * ships clamped so the link is present without scripting; this releases the
 * ones that fit.
 */
const setupClamping = () => {
  const cards = Array.from(
    document.querySelectorAll<HTMLElement>("[data-update-card]"),
  );
  if (!cards.length) return;

  const measure = () => {
    cards.forEach((card) => {
      const body = card.querySelector<HTMLElement>("[data-update-body]");
      if (!body) return;
      // Measured against the clamp, so the class has to be on while we look.
      card.classList.add("is-clamped");
      if (body.scrollHeight <= body.clientHeight + 4) {
        card.classList.remove("is-clamped");
      }
    });
  };

  measure();
  // Images and web fonts land after first paint and both change the height.
  window.addEventListener("resize", measure);
  document.fonts?.ready.then(measure);
};

/**
 * The whole card opens its detail page, except where the click landed on
 * something that already does its own thing — a link, the media player, or its
 * controls.
 */
const setupCardNavigation = () => {
  document
    .querySelectorAll<HTMLElement>("[data-update-card]")
    .forEach((card) => {
      const href = card.dataset.updateHref;
      if (!href) return;
      card.addEventListener("click", (e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest("a, button, [data-update-media]")) return;
        // A click that ends a text selection is someone copying.
        if (window.getSelection()?.toString()) return;
        window.location.href = href;
      });
    });
};

/**
 * Photo stacks. Only the active item is in flow, which is what lets the frame
 * keep each photo's own aspect ratio; the cards behind it are drawn in CSS.
 */
const setupMediaStacks = () => {
  document
    .querySelectorAll<HTMLElement>("[data-update-media][data-media-count]")
    .forEach((stack) => {
      const items = Array.from(
        stack.querySelectorAll<HTMLElement>(".update-media-item"),
      );
      if (items.length < 2) return;
      const position = stack.querySelector<HTMLElement>(
        "[data-media-position]",
      );
      let index = 0;

      const show = (next: number) => {
        const previous = items[index];
        previous.querySelector("video")?.pause();
        index = (next + items.length) % items.length;
        items.forEach((item, i) => {
          item.hidden = i !== index;
        });
        if (position) position.textContent = `${index + 1} / ${items.length}`;
      };

      stack
        .querySelector("[data-media-prev]")
        ?.addEventListener("click", () => show(index - 1));
      stack
        .querySelector("[data-media-next]")
        ?.addEventListener("click", () => show(index + 1));
    });
};

const formatTime = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "0:00";
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** Custom transport controls for update videos. */
const setupVideoPlayers = () => {
  document
    .querySelectorAll<HTMLElement>("[data-media-player]")
    .forEach((player) => {
      const video = player.querySelector("video");
      const toggle = player.querySelector<HTMLButtonElement>(
        "[data-media-toggle]",
      );
      const scrub = player.querySelector<HTMLElement>("[data-media-scrub]");
      const progress = player.querySelector<HTMLElement>(
        "[data-media-progress]",
      );
      const time = player.querySelector<HTMLElement>("[data-media-time]");
      const mute = player.querySelector<HTMLButtonElement>("[data-media-mute]");
      if (!video) return;

      const setPlayingState = (playing: boolean) => {
        player.classList.toggle("is-playing", playing);
        if (toggle) {
          toggle.setAttribute(
            "aria-label",
            playing ? "Pause video" : "Play video",
          );
        }
      };

      const togglePlayback = () => {
        if (video.paused) void video.play();
        else video.pause();
      };

      toggle?.addEventListener("click", togglePlayback);
      video.addEventListener("click", togglePlayback);
      video.addEventListener("play", () => setPlayingState(true));
      video.addEventListener("pause", () => setPlayingState(false));
      video.addEventListener("ended", () => setPlayingState(false));

      video.addEventListener("timeupdate", () => {
        const ratio = video.duration ? video.currentTime / video.duration : 0;
        if (progress) progress.style.width = `${ratio * 100}%`;
        if (time) time.textContent = formatTime(video.currentTime);
      });
      video.addEventListener("loadedmetadata", () => {
        if (time) time.textContent = formatTime(video.duration);
      });

      const seekTo = (clientX: number) => {
        if (!scrub || !video.duration) return;
        const { left, width } = scrub.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - left) / width));
        video.currentTime = ratio * video.duration;
      };
      scrub?.addEventListener("pointerdown", (e) => {
        seekTo(e.clientX);
        capturePointer(scrub, e.pointerId);
      });
      scrub?.addEventListener("pointermove", (e) => {
        if (e.buttons === 1) seekTo(e.clientX);
      });

      mute?.addEventListener("click", () => {
        video.muted = !video.muted;
        player.classList.toggle("is-muted", video.muted);
        mute.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
      });
    });
};

/** Full-size view for update photos, opened by the frame's expand button. */
const setupLightbox = () => {
  const triggers = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-media-expand]"),
  );
  if (!triggers.length) return;

  const overlay = document.createElement("div");
  overlay.className = "update-lightbox";
  overlay.hidden = true;
  overlay.innerHTML = `
    <button class="update-lightbox-close" type="button" aria-label="Close">×</button>
    <img class="update-lightbox-image" alt="">
  `;
  document.body.appendChild(overlay);
  const image = overlay.querySelector<HTMLImageElement>(
    ".update-lightbox-image",
  )!;
  let lastTrigger: HTMLButtonElement | null = null;

  const close = () => {
    overlay.hidden = true;
    document.body.classList.remove("update-lightbox-open");
    lastTrigger?.focus();
  };

  triggers.forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const source = trigger
        .closest(".update-player")
        ?.querySelector<HTMLImageElement>("img");
      if (!source) return;
      lastTrigger = trigger;
      image.src = source.currentSrc || source.src;
      image.alt = source.alt;
      overlay.hidden = false;
      document.body.classList.add("update-lightbox-open");
      overlay
        .querySelector<HTMLButtonElement>(".update-lightbox-close")
        ?.focus();
    });
  });

  overlay.addEventListener("click", (e) => {
    if (
      e.target === overlay ||
      (e.target as HTMLElement).closest(".update-lightbox-close")
    ) {
      close();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) close();
  });
};

window.addEventListener("load", () => {
  setupClamping();
  setupCardNavigation();
  setupMediaStacks();
  setupVideoPlayers();
  setupLightbox();
  setupTimeline();
  setupCommentCounts();
  setupCommentThread();
});
