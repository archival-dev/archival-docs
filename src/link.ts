// Approval half of the pairing flow: an agent shows a code and polls, a person
// lands here, clears Turnstile, and approves. The agent never sees a credential
// it did not earn, and the human check stays in a real browser.

import { track } from "./analytics";

declare global {
  interface Window {
    turnstile?: {
      render(
        el: HTMLElement,
        options: {
          sitekey: string;
          action?: string;
          execution?: "render" | "execute";
          appearance?: "always" | "execute" | "interaction-only";
          callback: (token: string) => void;
          "error-callback"?: () => void;
          "expired-callback"?: () => void;
        },
      ): string;
      execute(container: HTMLElement | string): void;
      reset(widgetId: string): void;
    };
  }
}

const TURNSTILE_ACTION = "build-with-claude";

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const setup = () => {
  const approve = el<HTMLButtonElement>("link-approve");
  if (!approve) {
    return;
  }
  const status = el("link-status");
  const code = new URL(window.location.href).searchParams.get("c") ?? "";

  el("link-code").textContent = code || "—";
  if (!code) {
    status.textContent =
      "This link is missing its code. Copy the whole URL your agent printed.";
    approve.disabled = true;
    return;
  }

  let widgetId: string | null = null;

  const fail = (message: string) => {
    status.textContent = message;
    approve.disabled = false;
    if (widgetId && window.turnstile) {
      window.turnstile.reset(widgetId);
    }
  };

  const send = async (turnstileToken: string) => {
    try {
      const response = await fetch(
        `${API_URL}/previews/self-serve/pair/approve`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, turnstileToken }),
        },
      );
      if (response.ok) {
        const { name } = (await response.json()) as { name: string };
        status.textContent = `Approved. Your agent is building ${name} — you can close this tab.`;
        approve.hidden = true;
        return;
      }
      // Each of these is a different mistake, and saying which one saves a
      // round trip through support.
      fail(
        response.status === 404
          ? "That code has expired. Ask your agent for a new one."
          : response.status === 409
            ? "That code was already approved."
            : response.status === 429
              ? "Too many attempts from this network. Try again in a minute."
              : "That didn't work. Please try again.",
      );
    } catch {
      fail("Couldn't reach Archival. Check your connection and try again.");
    }
  };

  if (window.turnstile) {
    widgetId = window.turnstile.render(el("link-turnstile"), {
      sitekey: TURNSTILE_SITE_KEY,
      action: TURNSTILE_ACTION,
      execution: "execute",
      appearance: "interaction-only",
      callback: (token) => void send(token),
      "error-callback": () => fail("The challenge failed. Please try again."),
      "expired-callback": () =>
        fail("The challenge expired. Please try again."),
    });
  }

  approve.addEventListener("click", () => {
    if (!widgetId || !window.turnstile) {
      fail("Couldn't load the challenge. Please reload the page.");
      return;
    }
    status.textContent = "";
    approve.disabled = true;
    track("link-approve");
    window.turnstile.execute(el("link-turnstile"));
  });
};

(
  window as unknown as { onloadTurnstileCallback?: () => void }
).onloadTurnstileCallback = setup;
if (window.turnstile) {
  setup();
}

export {};
