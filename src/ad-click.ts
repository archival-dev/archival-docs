/**
 * Carry a Google Ads click from the page an ad landed on to the editor, where
 * checkout reports it to Google Ads from the api.
 *
 * The click id rides on the editor link's query string, so reporting depends on
 * no third-party script or cookie that an ad blocker can remove. It is kept in
 * localStorage so that a visitor who reads a few pages first still carries it.
 */

const PARAMS = ["gclid", "gbraid", "wbraid"] as const;
const STORED_KEY = "ad-click";
// Google Ads' longest click-through conversion window.
const TTL_MS = 90 * 24 * 60 * 60 * 1000;

type AdClick = { param: (typeof PARAMS)[number]; id: string; at: number };

const EDITOR_ORIGINS = new Set([
  new URL(EDITOR_URL).origin,
  "https://editor.archival.dev",
]);

const storedClick = (): AdClick | null => {
  try {
    const click = JSON.parse(
      localStorage.getItem(STORED_KEY) ?? "null",
    ) as AdClick | null;
    return click && Date.now() - click.at < TTL_MS ? click : null;
  } catch {
    return null;
  }
};

const landingClick = (): AdClick | null => {
  const params = new URLSearchParams(window.location.search);
  for (const param of PARAMS) {
    const id = params.get(param);
    if (id) {
      return { param, id, at: Date.now() };
    }
  }
  return null;
};

const click = landingClick() ?? storedClick();
if (click) {
  try {
    localStorage.setItem(STORED_KEY, JSON.stringify(click));
  } catch {
    // Private mode: links on this page load still carry it.
  }
}

// Rewritten as the link is used rather than on load, so links the page builds
// later are covered too. pointerdown runs ahead of a middle click or the
// context menu's "open in new tab".
const decorate = (event: Event) => {
  if (!click || !(event.target instanceof Element)) {
    return;
  }
  const link = event.target.closest("a[href]");
  if (!(link instanceof HTMLAnchorElement)) {
    return;
  }
  const url = new URL(link.href);
  if (!EDITOR_ORIGINS.has(url.origin) || url.searchParams.has(click.param)) {
    return;
  }
  url.searchParams.set(click.param, click.id);
  link.href = url.toString();
};

document.addEventListener("pointerdown", decorate, { capture: true });
document.addEventListener("click", decorate, { capture: true });
