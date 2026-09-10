// Comments for the updates feed and the update detail pages, backed by the Val
// Town val in valtown/comments.ts. Counts on the feed come from one batched
// request; a thread is only fetched once its section nears the viewport.

interface Comment {
  id: number;
  parentId: number | null;
  author: string;
  body: string;
  role: "reader" | "team";
  createdAt: string;
  replies?: Comment[];
}

interface TurnstileApi {
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
}

const TURNSTILE_ACTION = "update-comment";
const NAME_KEY = "archival-comment-name";
const TOKEN_KEY = "archival-comment-token";

const turnstile = () =>
  (window as unknown as { turnstile?: TurnstileApi }).turnstile;

const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private browsing. The field just won't be remembered.
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing was stored to begin with.
    }
  },
};

/**
 * The team's posting token arrives as a query param once and lives in local
 * storage after that, so an author replies from the same form everyone else
 * uses.
 */
const adminToken = () => {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("comment_token");
  if (fromUrl) {
    store.set(TOKEN_KEY, fromUrl);
    url.searchParams.delete("comment_token");
    history.replaceState(null, "", url.toString());
    return fromUrl;
  }
  return store.get(TOKEN_KEY);
};

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

/** Stable per name, so the same commenter keeps the same avatar colour. */
const hue = (name: string) => {
  let total = 0;
  for (let i = 0; i < name.length; i += 1) {
    total = (total * 31 + name.charCodeAt(i)) % 360;
  }
  return total;
};

const shortDate = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
};

const plural = (count: number) => `${count} comment${count === 1 ? "" : "s"}`;

const avatar = (name: string, extraClass = "") => {
  const el = document.createElement("span");
  el.className = `comment-avatar ${extraClass}`.trim();
  el.style.setProperty("--comment-hue", String(hue(name)));
  el.setAttribute("aria-hidden", "true");
  el.textContent = initials(name);
  return el;
};

export const setupCommentCounts = () => {
  const targets = Array.from(
    document.querySelectorAll<HTMLElement>("[data-comment-count]"),
  );
  if (!targets.length) return;

  const slugs = Array.from(
    new Set(targets.map((el) => el.dataset.commentSlug ?? "").filter(Boolean)),
  );
  if (!slugs.length) return;

  void (async () => {
    try {
      const response = await fetch(
        `${COMMENTS_URL}/counts?slugs=${encodeURIComponent(slugs.join(","))}`,
      );
      if (!response.ok) return;
      const { counts } = (await response.json()) as {
        counts: Record<string, number>;
      };
      targets.forEach((el) => {
        const count = counts[el.dataset.commentSlug ?? ""] ?? 0;
        if (!count) return;
        el.textContent = plural(count);
        el.hidden = false;
      });
    } catch {
      // The feed reads fine without counts.
    }
  })();
};

export const setupCommentThread = () => {
  const root = document.querySelector<HTMLElement>("[data-comments]");
  const slug = root?.dataset.commentsSlug;
  if (!root || !slug) return;

  const list = root.querySelector<HTMLElement>("[data-comments-list]")!;
  const status = root.querySelector<HTMLElement>("[data-comments-status]")!;
  const total = root.querySelector<HTMLElement>("[data-comments-total]")!;
  const form = root.querySelector<HTMLFormElement>("[data-comment-form]")!;
  const nameField = form.querySelector<HTMLInputElement>(
    "[data-comment-name]",
  )!;
  const bodyField = form.querySelector<HTMLTextAreaElement>(
    "[data-comment-body]",
  )!;
  const post = form.querySelector<HTMLButtonElement>("[data-comment-post]")!;
  const error = form.querySelector<HTMLElement>("[data-comment-error]")!;
  const replyTo = form.querySelector<HTMLElement>("[data-comment-reply-to]")!;
  const replyToName = form.querySelector<HTMLElement>(
    "[data-comment-reply-name]",
  )!;
  const cancelReply = form.querySelector<HTMLButtonElement>(
    "[data-comment-reply-cancel]",
  )!;
  const challenge = form.querySelector<HTMLElement>(
    "[data-comment-turnstile]",
  )!;
  const youAvatar = form.querySelector<HTMLElement>("[data-comment-you]")!;

  let token = adminToken();
  let count = 0;
  let parentId: number | null = null;
  let widgetId: string | null = null;
  let challengeReady: Promise<void> | null = null;

  form.hidden = false;

  const setCount = (next: number) => {
    count = next;
    total.textContent = count ? ` · ${count}` : "";
  };

  const setYou = (name: string) => {
    youAvatar.classList.toggle("is-empty", !name);
    youAvatar.style.setProperty("--comment-hue", String(hue(name)));
    youAvatar.textContent = name ? initials(name) : "?";
  };

  const savedName = store.get(NAME_KEY);
  if (savedName) {
    nameField.value = savedName;
    setYou(savedName);
  }
  nameField.addEventListener("input", () => setYou(nameField.value.trim()));

  const growBody = () => {
    bodyField.style.height = "auto";
    bodyField.style.height = `${bodyField.scrollHeight}px`;
  };
  bodyField.addEventListener("input", growBody);

  const renderComment = (comment: Comment, depth = 0) => {
    const item = document.createElement("li");
    item.className = "comment";
    item.dataset.commentId = String(comment.id);
    if (comment.role === "team") item.classList.add("is-team");

    const head = document.createElement("div");
    head.className = "comment-head";
    head.appendChild(avatar(comment.author));

    const author = document.createElement("span");
    author.className = "comment-author";
    author.textContent = comment.author;
    head.appendChild(author);

    const time = document.createElement("time");
    time.className = "comment-date";
    time.dateTime = comment.createdAt;
    time.title = new Date(comment.createdAt).toLocaleString();
    time.textContent = shortDate(comment.createdAt);
    head.appendChild(time);
    item.appendChild(head);

    const bubble = document.createElement("div");
    bubble.className = "comment-bubble";
    // textContent, so a comment can never introduce markup.
    bubble.textContent = comment.body;
    item.appendChild(bubble);

    if (depth === 0) {
      const reply = document.createElement("button");
      reply.type = "button";
      reply.className = "comment-reply";
      reply.textContent = "Reply";
      reply.addEventListener("click", () =>
        startReply(comment.id, comment.author, item),
      );
      item.appendChild(reply);

      const replies = document.createElement("ol");
      replies.className = "comment-replies";
      replies.dataset.commentReplies = "";
      comment.replies?.forEach((child) =>
        replies.appendChild(renderComment(child, depth + 1)),
      );
      item.appendChild(replies);
    }

    return item;
  };

  const startReply = (id: number, author: string, item: HTMLElement) => {
    parentId = id;
    replyToName.textContent = author;
    replyTo.hidden = false;
    (item.querySelector("[data-comment-replies]") ?? item).after(form);
    form.classList.add("is-replying");
    bodyField.focus();
  };

  const endReply = () => {
    parentId = null;
    replyTo.hidden = true;
    form.classList.remove("is-replying");
    root.appendChild(form);
  };
  cancelReply.addEventListener("click", endReply);

  const insert = (comment: Comment) => {
    if (comment.parentId === null) {
      list.appendChild(renderComment(comment));
      return;
    }
    const parent = list.querySelector<HTMLElement>(
      `[data-comment-id="${comment.parentId}"] [data-comment-replies]`,
    );
    if (parent) parent.appendChild(renderComment(comment, 1));
    else list.appendChild(renderComment(comment));
  };

  const load = async () => {
    try {
      const response = await fetch(
        `${COMMENTS_URL}/thread?slug=${encodeURIComponent(slug)}`,
      );
      if (!response.ok) throw new Error(String(response.status));
      const thread = (await response.json()) as {
        count: number;
        comments: Comment[];
      };
      list.replaceChildren(
        ...thread.comments.map((comment) => renderComment(comment)),
      );
      setCount(thread.count);
      status.textContent = thread.count ? "" : "No comments yet. Go first.";
    } catch {
      status.textContent = "Couldn't load the comments. Reload to try again.";
    }
  };

  const send = async (turnstileToken: string | null) => {
    try {
      const response = await fetch(`${COMMENTS_URL}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          slug,
          author: nameField.value.trim(),
          body: bodyField.value,
          parentId,
          turnstileToken,
        }),
      });
      if (!response.ok) {
        const { error: message } = (await response
          .json()
          .catch(() => ({ error: "" }))) as { error?: string };
        // A token the val no longer accepts would keep skipping the challenge
        // on every retry, so drop it and let the next attempt take the widget.
        if (token && response.status !== 429) {
          store.remove(TOKEN_KEY);
          token = null;
          throw new Error("That token is no longer good. Try again.");
        }
        throw new Error(message || "That didn't post. Please try again.");
      }
      const { comment } = (await response.json()) as { comment: Comment };
      endReply();
      insert(comment);
      setCount(count + 1);
      status.textContent = "";
      store.set(NAME_KEY, nameField.value.trim());
      bodyField.value = "";
      growBody();
      (
        window as unknown as { umami?: { track: (event: string) => void } }
      ).umami?.track("update-comment-post");
    } catch (thrown) {
      error.textContent =
        thrown instanceof Error
          ? thrown.message
          : "That didn't post. Please try again.";
    } finally {
      post.disabled = false;
      if (widgetId) turnstile()?.reset(widgetId);
    }
  };

  // The Turnstile script is only pulled in once someone starts writing, so a
  // reader who never comments never loads it.
  const prepareChallenge = () => {
    challengeReady ??= new Promise<void>((resolve, reject) => {
      if (turnstile()) {
        resolve();
        return;
      }
      (
        window as unknown as { onloadCommentsTurnstile?: () => void }
      ).onloadCommentsTurnstile = () => resolve();
      const script = document.createElement("script");
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadCommentsTurnstile&render=explicit";
      script.async = true;
      script.defer = true;
      script.addEventListener("error", () => reject(new Error("turnstile")));
      document.head.appendChild(script);
    }).then(() => {
      widgetId ??=
        turnstile()?.render(challenge, {
          sitekey: TURNSTILE_SITE_KEY,
          action: TURNSTILE_ACTION,
          execution: "execute",
          appearance: "interaction-only",
          callback: (value) => void send(value),
          "error-callback": () => {
            error.textContent = "The challenge failed. Please try again.";
            post.disabled = false;
          },
          "expired-callback": () => {
            error.textContent = "The challenge expired. Please try again.";
            post.disabled = false;
          },
        }) ?? null;
    });
    return challengeReady;
  };
  if (!token) {
    bodyField.addEventListener(
      "focus",
      () => void prepareChallenge().catch(() => {}),
      {
        once: true,
      },
    );
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    error.textContent = "";
    if (!nameField.value.trim() || !bodyField.value.trim()) {
      error.textContent = "A name and a comment, please.";
      return;
    }
    post.disabled = true;
    if (token) {
      void send(null);
      return;
    }
    prepareChallenge()
      .then(() => {
        if (!widgetId) throw new Error("no widget");
        turnstile()?.execute(challenge);
      })
      .catch(() => {
        error.textContent = "Couldn't load the challenge. Please reload.";
        post.disabled = false;
      });
  });

  bodyField.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  let loaded = false;
  const loadOnce = () => {
    if (loaded) return;
    loaded = true;
    void load();
  };

  if (
    window.location.hash === "#comments" ||
    !("IntersectionObserver" in window)
  ) {
    loadOnce();
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      loadOnce();
    },
    { rootMargin: "400px 0px" },
  );
  observer.observe(root);
};
