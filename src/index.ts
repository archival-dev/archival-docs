declare const umami:
  | { track: (event: string, data?: Record<string, string | number>) => void }
  | undefined;

window.addEventListener("load", () => {
  pointBrowseLinkAtEditor();
  void setupTemplateMosaic();
  // setupHeaderVideos();
  setupHeroTitleTilt();
  setupMobileMenu();
  setupDocsMenu();
  setupQuickSearch();

  let needsUpdate = true;
  const update = () => {
    if (needsUpdate) {
      needsUpdate = false;
      updateShadowImages();
    }
  };
  const debouncedUpdate = () => {
    needsUpdate = true;
    requestAnimationFrame(update);
  };
  window.addEventListener("scroll", debouncedUpdate);
  window.addEventListener("resize", debouncedUpdate);
  update();
});

/**
 * Fill the mosaic from the editor's own catalog.
 *
 * templates.json is served from the editor origin with
 * access-control-allow-origin: *, and carries the five repo fields that make up
 * a template's identifier. That is all this needs: the identifier addresses the
 * template in the gallery, and the same parts spell the thumbnail path.
 *
 * Progressive enhancement on purpose. The heading, the line under it and the
 * browse link are in the markup already, so a failed fetch, an empty catalog or
 * no JS at all leaves a section that still reads and still leads somewhere.
 */

/**
 * Seconds a tile takes to travel its own width.
 *
 * The drift is stated as a speed rather than a duration so it does not depend
 * on how many templates the catalog holds: the row is a wall of sites going
 * past at a readable pace, and that pace is a property of the band, not of the
 * number of tiles filling it. Expressed per tile rather than in pixels so the
 * band still drifts faster on a large display, where the tiles are bigger.
 */
const SECONDS_PER_TILE = 15;

/**
 * `TemplateObject::identifier()` in the editor: the five parts url-encoded and
 * joined by "/". It has to be encodeURIComponent'd again into the query string,
 * because the parts carry percent-escapes of their own - dropped in raw,
 * URLSearchParams would decode them and the id would no longer match.
 */
const templateId = (t: Template) =>
  [t.repo_provider, t.repo_owner, t.repo_name, t.repo_ref, t.name]
    .map(encodeURIComponent)
    .join("/");

const shuffled = <T,>(items: T[]) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** Written by the editor's cache-templates step, keyed the same way. */
const thumbnailUrl = (t: Template) =>
  `${EDITOR_URL}/${t.repo_provider}-${t.repo_owner}-${t.repo_name}-${t.repo_ref.replace(/\//g, "_")}/thumbnail.jpg`;

type Template = {
  name: string;
  repo_provider: string;
  repo_owner: string;
  repo_name: string;
  repo_ref: string;
};

/**
 * Send the browse link to the editor this build targets.
 *
 * The markup carries the production editor, which is what a visitor with no JS
 * needs; this is what makes local and staging reach their own.
 */
const pointBrowseLinkAtEditor = () => {
  const link = document.getElementById("browse-templates");
  if (link instanceof HTMLAnchorElement) {
    link.href = `${EDITOR_URL}/new`;
  }
};

/**
 * The editor's catalog, or null if it cannot be had.
 *
 * Separate from the mosaic itself because the mosaic has to hand its space
 * back on every way this can fail, and one caller checking one value is
 * harder to leave a hole in than four early returns.
 */
const loadTemplates = async (): Promise<Template[] | null> => {
  try {
    const response = await fetch(`${EDITOR_URL}/templates.json`);
    if (!response.ok) {
      return null;
    }
    const { templates } = (await response.json()) as { templates: Template[] };
    return Array.isArray(templates) && templates.length > 0 ? templates : null;
  } catch (error) {
    // Degrading quietly is right for an unreachable editor: the section still
    // reads and the browse link still works. Saying so is right for everything
    // else - this swallowed a ReferenceError once (a dev server holding an
    // esbuild context from before EDITOR_URL existed, since esbuild's watch
    // captures its defines at startup and never re-reads build.mjs) and the
    // silence was the expensive part, not the failure.
    console.warn("Could not load the template catalog:", error);
    return null;
  }
};

const setupTemplateMosaic = async () => {
  // Only the home page carries the mosaic. Bail before fetching anything so
  // every other page does not pay for a request it will not use.
  const mosaic = document.getElementById("template-mosaic");
  if (!mosaic) {
    return;
  }

  const templates = await loadTemplates();
  if (!templates) {
    // The band is in the markup and holding its height (so nothing below it
    // moves when the tiles land), so an editor that cannot be reached has to
    // give that space back rather than leave a band of nothing above the link.
    mosaic.hidden = true;
    return;
  }

  const tile = (template: Template) => {
    const el = document.createElement("a");
    el.className = "template-tile";
    el.href = `${EDITOR_URL}/new?template=${encodeURIComponent(templateId(template))}`;
    el.setAttribute("data-umami-event", "hero-template-pick");

    const shot = document.createElement("span");
    shot.className = "template-tile-shot";
    const img = document.createElement("img");
    img.src = thumbnailUrl(template);
    img.loading = "lazy";
    // Decorative: the name below already says which template this is, and a
    // screen reader does not need to hear it twice.
    img.alt = "";
    // Thumbnails only exist once the gallery ships. Until then - and for any
    // template whose shot has not been captured - the tile falls back to its
    // name on an empty frame rather than a broken image.
    img.addEventListener("error", () => el.classList.add("no-shot"));
    shot.appendChild(img);

    const name = document.createElement("span");
    name.className = "template-tile-name";
    name.textContent = template.name;

    el.append(shot, name);
    return el;
  };

  /**
   * Fill a track so it can loop seamlessly at this width.
   *
   * The animation runs to -50%, so the first half of the track has to be at
   * least as wide as the row, or the loop drags empty space through the far
   * end. A small catalog on a wide display does not manage that in one pass,
   * so the templates repeat until a half covers the row.
   *
   * Only the first pass is exposed. Everything after it is the same templates
   * again, so it is hidden from assistive tech and taken out of the tab order
   * rather than announcing and focusing each template several times.
   */
  const fillTrack = (
    rowEl: HTMLElement,
    track: HTMLElement,
    items: Template[],
  ) => {
    track.replaceChildren();
    for (const template of items) {
      track.appendChild(tile(template));
    }
    const passWidth = track.scrollWidth;
    const passes = Math.max(1, Math.ceil(rowEl.clientWidth / passWidth));
    const addHiddenPass = () => {
      for (const template of items) {
        const el = tile(template);
        el.setAttribute("aria-hidden", "true");
        el.tabIndex = -1;
        track.appendChild(el);
      }
    };
    // Complete the first half, then mirror it. -50% is then exactly one half.
    for (let i = 1; i < passes; i += 1) addHiddenPass();
    for (let i = 0; i < passes; i += 1) addHiddenPass();
    // The keyframe is a percentage of the track, so the duration is what sets
    // the speed, and it has to be a function of how far a half actually is.
    track.style.animationDuration = `${passes * items.length * SECONDS_PER_TILE}s`;
  };

  const row = (items: Template[], reverse: boolean) => {
    const rowEl = document.createElement("div");
    rowEl.className = "marquee-row";
    const track = document.createElement("div");
    track.className = reverse ? "marquee-track reverse" : "marquee-track";
    rowEl.appendChild(track);
    return { rowEl, refill: () => fillTrack(rowEl, track, items) };
  };

  // Shuffled, so a reload is a different wall rather than the same one again -
  // and so no template is permanently the one at the front of the catalog.
  const featured = shuffled(templates);
  // Split across two rows that drift against each other. An odd count puts the
  // extra one on top, where the row is read first.
  const split = Math.ceil(featured.length / 2);
  const rows = [
    row(featured.slice(0, split), false),
    row(featured.slice(split), true),
  ];
  mosaic.append(...rows.map((r) => r.rowEl));
  // Measured, so it has to happen after the rows are laid out - and again when
  // the window grows, or a track that covered the row stops covering it.
  const refillAll = () => rows.forEach((r) => r.refill());
  refillAll();
  let resizeFrame: number | undefined;
  window.addEventListener("resize", () => {
    if (resizeFrame) window.clearTimeout(resizeFrame);
    resizeFrame = window.setTimeout(() => {
      refillAll();
      measureCurve();
    }, 150);
  });

  /**
   * The curve.
   *
   * The band is a screen wrapping around the viewer: flat straight ahead, and
   * curling toward you at both ends, so a tile out at the side is nearer the
   * camera and draws larger. A tile's transform therefore depends on where it
   * is right now, which is why this runs per frame instead of being declared
   * in CSS - the tiles never stop moving.
   *
   * Cheap on purpose, and independent of how long the catalog is. Each tile's
   * offset within its track is measured once and cached; per frame this reads
   * one box (the track's) and writes transforms only for the tiles actually
   * over the row, rather than asking the browser where every tile is. The rest
   * of the track is clipped, so the work that matters is set by the width of
   * the display and not by the number of templates strung across it.
   */
  type Curved = { el: HTMLElement; centre: number; radius: number };
  let curved: { track: HTMLElement; row: HTMLElement; tiles: Curved[] }[] = [];
  let depth = 0;
  let turn = 0;

  const measureCurve = () => {
    const style = getComputedStyle(mosaic);
    depth = parseFloat(style.getPropertyValue("--curve-depth")) || 0;
    turn = parseFloat(style.getPropertyValue("--curve-turn")) || 0;
    const tracks = rows.map(
      ({ rowEl }) => rowEl.querySelector(".marquee-track") as HTMLElement,
    );
    // A tile's offset is taken from its rendered box, so any curve still on it
    // from an earlier run would be measured in as part of where it sits.
    for (const track of tracks) {
      for (const child of track.children) {
        (child as HTMLElement).style.transform = "";
      }
    }
    curved = rows.map(({ rowEl }, i) => {
      const track = tracks[i];
      const trackLeft = track.getBoundingClientRect().left;
      const tiles = [...track.children].map((child) => {
        const el = child as HTMLElement;
        const box = el.getBoundingClientRect();
        return {
          el,
          centre: box.left - trackLeft + box.width / 2,
          radius: box.width / 2,
        };
      });
      return { track, row: rowEl, tiles };
    });
  };

  const drawCurve = () => {
    for (const { track, row, tiles } of curved) {
      const trackLeft = track.getBoundingClientRect().left;
      const rowBox = row.getBoundingClientRect();
      const half = rowBox.width / 2;
      const middle = rowBox.left + half;
      for (const { el, centre, radius } of tiles) {
        const offset = trackLeft + centre - middle;
        // Clipped by the row, so nothing it is given would be seen. The track
        // runs the whole catalog past a fixed window; this is what keeps the
        // per-frame cost the size of the window rather than the catalog.
        if (Math.abs(offset) > half + radius) continue;
        // -1 at the left edge of the row, 0 dead ahead, 1 at the right edge.
        // Clamped there: past the edge a tile is inside the fade anyway, and
        // letting p run on squared into a translateZ that pushed tiles most of
        // the way to the camera and blew them up to twice their size.
        const p = Math.max(-1, Math.min(1, offset / half));
        // Squared, so the middle stays flat and the curve gathers at the ends
        // rather than tilting everything a little.
        // depth is a fraction of the row, so the curve scales with the display
        // the same way the tiles and the perspective do.
        const push = p * p * depth * rowBox.width;
        el.style.transform = `translateZ(${push.toFixed(1)}px) rotateY(${(-p * turn).toFixed(2)}deg)`;
      }
    }
  };

  let frame = 0;
  const run = () => {
    drawCurve();
    frame = requestAnimationFrame(run);
  };
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };

  const flat = window.matchMedia("(prefers-reduced-motion: reduce)");
  const start = () => {
    stop();
    if (flat.matches) return;
    measureCurve();
    run();
  };
  start();
  flat.addEventListener("change", start);

  // Nothing to compute while the rows are off screen, and a page that keeps a
  // rAF loop running out of view is just spending someone's battery.
  if ("IntersectionObserver" in window) {
    new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !flat.matches) {
          if (!frame) {
            measureCurve();
            run();
          }
        } else {
          stop();
        }
      },
      { rootMargin: "200px" },
    ).observe(mosaic);
  }
};

// Factor by which to offset shadow
const SHADOW_DISTANCE = 20;
const updateShadowImages = () => {
  const viewH = window.innerHeight;
  document.querySelectorAll(".shadow-image").forEach((img, i) => {
    const shadow = img.querySelector(".bg") as HTMLImageElement;
    const { top, height } = img.getBoundingClientRect();
    const topDistance = top + height / 2;
    const center = topDistance / viewH;
    // Shadow move in the inverse direction of scroll, on a logarithmic curve
    const size = center * SHADOW_DISTANCE;
    const yShift = Math.log(size) * SHADOW_DISTANCE;
    shadow.style.transform = `translateY(${yShift - SHADOW_DISTANCE}px)`;
  });
};

const setupDocsMenu = () => {
  const menuButton = document.querySelector("#mobile-current-view") as
    HTMLDivElement | undefined;
  const menu = document.querySelector("#docs-selector") as
    HTMLDivElement | undefined;
  if (menuButton && menu) {
    const toggleMenu = (e: Event) => {
      e.preventDefault();
      menu.classList.toggle("showing");
    };
    menuButton.addEventListener("touchstart", toggleMenu);
    menuButton.addEventListener("click", toggleMenu);
    // Section links navigate within the current page, so the menu won't be
    // dismissed by a page load - close it explicitly.
    menu.querySelectorAll(".mobile-nav-subitem").forEach((link) => {
      link.addEventListener("click", () => {
        menu.classList.remove("showing");
      });
    });
  }
};

const setupMobileMenu = () => {
  const menu = document.querySelector("#mobile-menu") as HTMLDivElement;
  const backdrop = document.querySelector(".modal-backdrop") as HTMLDivElement;
  const nav = document.querySelector("nav") as HTMLDivElement;
  const [closedMenu, openMenu] = [
    document.querySelector("#menu-closed"),
    document.querySelector("#menu-open"),
  ];
  let prevOp: number | undefined;
  const toggleMenu = (open: boolean) => {
    if (prevOp) {
      clearTimeout(prevOp);
    }
    if (!open) {
      prevOp = setTimeout(() => {
        menu?.classList.toggle("hidden", true);
        backdrop?.classList.toggle("hidden", true);
      }, 500);
    } else {
      menu?.classList.toggle("hidden", false);
      backdrop?.classList.toggle("hidden", false);
    }
    setTimeout(() => {
      closedMenu?.classList.toggle("hidden", open);
      openMenu?.classList.toggle("hidden", !open);
      menu.classList.toggle("translate-y-full", !open);
      backdrop.classList.toggle("opacity-0", !open);
      menu.classList.toggle("opacity-0", !open);
      nav.classList.toggle("shadow-up", !open);
    }, 25);
  };
  closedMenu?.addEventListener("click", () => {
    if (typeof umami !== "undefined") umami.track("mobile-menu-open");
    toggleMenu(true);
  });
  openMenu?.addEventListener("click", () => {
    toggleMenu(false);
  });
  backdrop?.addEventListener("click", () => {
    toggleMenu(false);
  });
};

type SearchResultsRaw = {
  sections: [
    {
      path: string;
      docTitle: string;
      sectionTitle: string | null;
      content: string;
    },
  ];
};

type SearchResult = SearchResultsRaw["sections"][0] & {
  oTitle: string;
  oSection: string | null;
};

type ResultMatch = SearchResult & {
  snippet: string;
  startIndex: number;
  matchLen: number;
};

const MAX_RESULTS = 5;
const SNIPPET_PREFIX = 10;
const SNIPPPET_SIZE = 100;

const stripHTML = (s: string) => {
  const tmp = document.createElement("div");
  tmp.innerHTML = s;
  return tmp.textContent || tmp.innerText || "";
};

const setupQuickSearch = async () => {
  const searchResults = (await (
    await fetch("/api/docs.json")
  ).json()) as SearchResultsRaw;
  const sections: SearchResult[] = searchResults.sections.map((_s) => {
    const s: SearchResult = {
      ..._s,
      oTitle: _s.docTitle,
      oSection: _s.sectionTitle,
    };
    s.content = stripHTML(decodeURIComponent(s.content).toLowerCase());
    s.docTitle = s.docTitle.toLowerCase();
    s.sectionTitle = s.sectionTitle?.toLowerCase() || null;
    return s;
  });
  // TODO if this is too slow we can switch to a trie-based approach or simplify
  // the content by adding a non-parsed markdown output to sections
  const showSearch = () => {
    modal.classList.toggle("hidden", false);
    input.focus();
  };
  const hideSearch = () => {
    modal.classList.toggle("hidden", true);
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "k" && e.metaKey) {
      showSearch();
    }
    if (e.key === "Escape") {
      hideSearch();
    }
  });
  window.addEventListener("hashchange", hideSearch);
  const modal = document.querySelector("#quick-search") as HTMLDivElement;
  const resultsEl = document.querySelector("#results") as HTMLUListElement;
  const emptyResult = document.querySelector("#results-empty") as HTMLLIElement;
  const notFoundResult = document.querySelector(
    "#results-none",
  ) as HTMLLIElement;
  const result = document.querySelector("#results-result") as HTMLLIElement;
  const input = document.querySelector(
    "#quick-search-input",
  ) as HTMLInputElement;
  document
    .querySelector("#quick-search-button")
    ?.addEventListener("click", () => {
      if (modal.classList.contains("hidden")) {
        showSearch();
      } else {
        hideSearch();
      }
    });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      hideSearch();
    }
  });
  let selectedIndex = -1;
  let currentResults: ResultMatch[] = [];
  input.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "Enter":
        hideSearch();
        if (selectedIndex > -1) {
          window.location.href = currentResults[selectedIndex].path;
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        selectedIndex = (selectedIndex - 1) % currentResults.length;
        break;
      case "ArrowDown":
        e.preventDefault();
        selectedIndex = (selectedIndex + 1) % currentResults.length;
        break;
      default:
        return;
    }
    resultsEl.querySelectorAll(".result").forEach((r, idx) => {
      r.classList.toggle("bg-gray-light", idx === selectedIndex);
    });
  });
  input.addEventListener("input", () => {
    resultsEl.innerHTML = "";
    selectedIndex = -1;
    const terms = input.value.split(/\s+/).map((t) => t.toLowerCase());
    if (!terms.length) {
      const r = emptyResult.cloneNode(true) as HTMLLIElement;
      r.classList.toggle("hidden", false);
      resultsEl.appendChild(r);
      return;
    }
    const results: ResultMatch[] = [];
    const getMatchIdx = (t: string, s: string): [false | number, string] => {
      const idx = s.indexOf(t);
      if (idx === -1) {
        return [false, ""];
      }
      const snipStart = Math.max(idx - SNIPPET_PREFIX, 0);
      const snippet = s.slice(snipStart, snipStart + SNIPPPET_SIZE);
      return [idx - snipStart, snippet];
    };
    for (const s of sections) {
      for (const t of terms) {
        let [startIndex, snippet] = getMatchIdx(t, s.docTitle);
        if (!startIndex && s.sectionTitle) {
          [startIndex, snippet] = getMatchIdx(t, s.sectionTitle);
        }
        if (!startIndex && s.content) {
          [startIndex, snippet] = getMatchIdx(t, s.content);
        }
        if (startIndex !== false) {
          results.push({
            ...s,
            startIndex,
            snippet,
            matchLen: t.length,
          });
          // If we find any term, stop searching since we'll include this section
          break;
        }
      }
      if (results.length >= MAX_RESULTS) {
        break;
      }
    }
    currentResults = results;
    if (results.length === 0) {
      const r = notFoundResult.cloneNode(true) as HTMLLIElement;
      r.classList.toggle("hidden", false);
      resultsEl.appendChild(r);
      return;
    }
    results.forEach((r) => {
      const rEl = result.cloneNode(true) as HTMLLIElement;
      rEl.classList.toggle("hidden", false);
      (rEl.querySelector(".doc-page") as HTMLElement).innerText = r.oTitle;
      const sectionEl = rEl.querySelector(".doc-section") as HTMLElement;
      if (r.oSection) {
        sectionEl.innerText = r.oSection;
      } else {
        rEl.querySelector(".match")?.removeChild(sectionEl);
      }
      (rEl.querySelector(".link") as HTMLAnchorElement).href = r.path;
      const pre = r.snippet.slice(0, r.startIndex);
      const hl = r.snippet.slice(r.startIndex, r.startIndex + r.matchLen);
      const rest = r.snippet.slice(r.startIndex + r.matchLen);
      rEl.querySelector(".snippet-pre")!.innerHTML = pre;
      rEl.querySelector(".snippet-hl")!.innerHTML = hl;
      rEl.querySelector(".snippet-rest")!.innerHTML = rest;
      resultsEl.appendChild(rEl);
    });
  });
};

const setupHeroTitleTilt = () => {
    const heroes = document.querySelectorAll('[data-tilt-hero]') as NodeListOf<HTMLElement>;
    const heroMaxTilt = 12;
    const heroPerspective = 1200;

    heroes.forEach((hero) => {
      function handleMouseMove(e: MouseEvent) {
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;

        const rotateX = ((e.clientY - centerY) / centerY) * -heroMaxTilt;
        const rotateY = ((e.clientX - centerX) / centerX) * heroMaxTilt;

        // Update color gradient position
        const percentX = (e.clientX / window.innerWidth) * 100;
        const percentY = (e.clientY / window.innerHeight) * 100;
        hero.style.setProperty('--hero-mouse-x', percentX + '%');
        hero.style.setProperty('--hero-mouse-y', percentY + '%');

        hero.style.transform = `perspective(${heroPerspective}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
      }

      function handleMouseLeave() {
        hero.style.transition = 'transform 0.5s ease-out';
        hero.style.transform = 'perspective(1200px) rotateX(0deg) rotateY(0deg)';
        setTimeout(() => {
          hero.style.transition = 'none';
        }, 500);
      }

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseleave', handleMouseLeave);
    });

}

// const setupHeaderVideos = () => {
//   const hi = document.getElementById("header-image") as HTMLDivElement;
//   const headerLogo = document.getElementById("header-logo") as HTMLDivElement;
//   const headerVideos = document.querySelectorAll(
//     ".header-video"
//   ) as NodeListOf<HTMLVideoElement>;
//   let loadedCount = 0;
//   let ci = 0;
//   let cv = headerVideos.item(ci);
//   let playing = false;
//   const setupHandlersIfLoaded = () => {
//     if (loadedCount >= headerVideos.length) {
//       hi.classList.toggle("hidden", true);
//       cv.classList.toggle("hidden", false);
//       cv.currentTime = 0.25;
//       headerLogo.addEventListener("click", () => {
//         if (playing) {
//           return;
//         }
//         cv.classList.toggle("hidden", true);
//         ci = ++ci % headerVideos.length;
//         cv = headerVideos.item(ci);
//         cv.classList.toggle("hidden", false);
//         cv.currentTime = 0;
//         cv.play();
//         playing = true;
//       });
//     }
//   };
//   headerVideos.forEach((hv) => {
//     if (hv.readyState >= 3) {
//       loadedCount++;
//     }
//     hv.classList.toggle("hidden", true);
//     hv.addEventListener("load", () => {
//       loadedCount++;
//       setupHandlersIfLoaded();
//     });
//     hv.addEventListener("ended", () => {
//       playing = false;
//     });
//   });
//   setupHandlersIfLoaded();
// };

if (DEV) {
  console.log("Dev Mode enabled");
  // ESBuild watch
  new EventSource("/esbuild").addEventListener("change", () =>
    location.reload(),
  );
}
