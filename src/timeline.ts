/**
 * Keep a drag on the element it started on. Throws for a pointer the browser no
 * longer considers active, which must not take the drag itself down with it.
 */
export const capturePointer = (el: Element, pointerId: number) => {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // The drag still works, it just stops tracking outside the element.
  }
};

/**
 * The rail on the right. Dated dots sit where their date falls between the
 * oldest and newest item, so a quiet month reads as a gap rather than as one
 * more evenly spaced tick; undated dots are spaced evenly. The thumb follows
 * the reader down the list, and the rail can be dragged to scrub through it.
 */
export const setupTimeline = () => {
  const timeline = document.querySelector<HTMLElement>("[data-timeline]");
  if (!timeline) return;

  const items = Array.from(
    timeline.querySelectorAll<HTMLElement>("[data-timeline-item]"),
  );
  const fill = timeline.querySelector<HTMLElement>("[data-timeline-fill]");
  const thumb = timeline.querySelector<HTMLElement>("[data-timeline-thumb]");
  const rail = timeline.querySelector<HTMLElement>(".updates-timeline-rail");
  if (items.length < 2 || !rail) return;

  const dates = items.map((item) => Number(item.dataset.timelineDate ?? 0));
  const newest = Math.max(...dates);
  const span = newest - Math.min(...dates);

  // Kept off the ends so the first and last dot aren't clipped by the rail cap.
  const TOP = 4;
  const BOTTOM = 96;
  // Dates set the spacing; this is the floor under it, so two items days
  // apart in a year of history still get their own dot.
  const MIN_GAP = Math.min(5, (BOTTOM - TOP) / Math.max(1, items.length - 1));

  const offsets = dates.map((date, i) => {
    const ratio = span ? (newest - date) / span : i / (items.length - 1);
    return TOP + ratio * (BOTTOM - TOP);
  });
  for (let i = 1; i < offsets.length; i += 1) {
    offsets[i] = Math.max(offsets[i], offsets[i - 1] + MIN_GAP);
  }
  // Pushing dots apart can run the oldest past the end of the rail. The gap is
  // capped at an even division of the rail, so pulling the run back up from the
  // bottom always fits.
  offsets[offsets.length - 1] = Math.min(offsets[offsets.length - 1], BOTTOM);
  for (let i = offsets.length - 2; i >= 0; i -= 1) {
    offsets[i] = Math.min(offsets[i], offsets[i + 1] - MIN_GAP);
  }
  items.forEach((item, i) => {
    item.style.top = `${offsets[i]}%`;
  });
  timeline.classList.add("is-positioned");

  const cards = items.map((item) =>
    document.getElementById(item.dataset.timelineTarget ?? ""),
  );

  const setActive = (index: number) => {
    items.forEach((item, i) => item.classList.toggle("is-active", i === index));
    const at = offsets[index];
    if (fill) fill.style.height = `${at}%`;
    if (thumb) thumb.style.top = `${at}%`;
  };

  // Whichever card's top edge is the last one above the reading line.
  const update = () => {
    const line = window.innerHeight * 0.35;
    let active = 0;
    cards.forEach((card, i) => {
      if (card && card.getBoundingClientRect().top <= line) active = i;
    });
    setActive(active);
  };

  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      update();
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  update();

  const scrollToCard = (card: HTMLElement | null) => {
    card?.scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
      block: "start",
    });
  };

  items.forEach((item, i) => {
    item.querySelector("a")?.addEventListener("click", (e) => {
      e.preventDefault();
      scrollToCard(cards[i]);
    });
  });

  // Dragging the rail jumps to the item nearest the grabbed position, which
  // is what makes it read as a slider rather than a list of anchors.
  const scrubTo = (clientY: number) => {
    const { top, height } = rail.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientY - top) / height)) * 100;
    let nearest = 0;
    offsets.forEach((offset, i) => {
      if (Math.abs(offset - ratio) < Math.abs(offsets[nearest] - ratio)) {
        nearest = i;
      }
    });
    scrollToCard(cards[nearest]);
  };
  rail.addEventListener("pointerdown", (e) => {
    if ((e.target as HTMLElement).closest("a")) return;
    timeline.classList.add("is-scrubbing");
    scrubTo(e.clientY);
    capturePointer(rail, e.pointerId);
  });
  rail.addEventListener("pointermove", (e) => {
    if (e.buttons === 1 && timeline.classList.contains("is-scrubbing")) {
      scrubTo(e.clientY);
    }
  });
  const endScrub = () => timeline.classList.remove("is-scrubbing");
  rail.addEventListener("pointerup", endScrub);
  rail.addEventListener("pointercancel", endScrub);
};
