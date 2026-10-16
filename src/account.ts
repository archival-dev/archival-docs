// Accounts for commenting on updates. An account is a passkey: no password
// and no email. Signing in goes straight to the browser's passkey prompt, so
// a returning reader never sees a dialog; only someone without a passkey is
// offered one. Sessions travel in request bodies, since the carrier can't
// read cookies, and live in local storage between visits.

const SESSION_KEY = "archival-comment-session";
const CLAIM_KEY = "archival-comment-token";

export interface User {
  id: number;
  name: string;
  role: "reader" | "team";
}

interface Signed {
  session?: string;
  user: User;
}

type Json = Record<string, unknown>;

export class RequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Private browsing. Nothing is remembered.
    }
  },
};

const answer = async <T>(response: Response): Promise<T> => {
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok) {
    throw new RequestError(
      data.error || "That didn't work. Please try again.",
      response.status,
    );
  }
  return data as T;
};

export const read = async <T>(action: string, query: Json): Promise<T> => {
  const params = new URLSearchParams({ action });
  Object.entries(query).forEach(([key, value]) =>
    params.set(key, String(value)),
  );
  return answer<T>(await fetch(`${COMMENTS_URL}?${params}`));
};

export const write = async <T>(action: string, body: Json): Promise<T> =>
  answer<T>(
    await fetch(`${COMMENTS_URL}?action=${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const state: { user: User | null } = { user: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

const signedIn = ({ session, user }: Signed): User => {
  if (session) store.set(SESSION_KEY, session);
  state.user = user;
  emit();
  return user;
};

const signedOut = () => {
  store.set(SESSION_KEY, null);
  state.user = null;
  emit();
};

export const account = {
  get user(): User | null {
    return state.user;
  },
  onChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** A request made as the signed-in account. A 401 means the session is gone. */
export const asUser = async <T>(action: string, body: Json = {}): Promise<T> => {
  try {
    return await write<T>(action, { ...body, session: store.get(SESSION_KEY) });
  } catch (thrown) {
    if (thrown instanceof RequestError && thrown.status === 401) signedOut();
    throw thrown;
  }
};

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    atob(base64 + "===".slice((base64.length + 3) % 4)),
    (char) => char.charCodeAt(0),
  );
};

const toBase64 = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const withIds = (list: unknown) =>
  Array.isArray(list)
    ? list.map((item: Json) => ({ ...item, id: fromBase64(String(item.id)) }))
    : undefined;

// The JSON the carrier sends and expects, converted to and from the binary
// WebAuthn takes.
const creationOptions = (json: Json): PublicKeyCredentialCreationOptions => {
  const user = json.user as Json;
  return {
    ...json,
    challenge: fromBase64(String(json.challenge)),
    user: { ...user, id: fromBase64(String(user.id)) },
    excludeCredentials: withIds(json.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
};

const requestOptions = (json: Json): PublicKeyCredentialRequestOptions =>
  ({
    ...json,
    challenge: fromBase64(String(json.challenge)),
    allowCredentials: withIds(json.allowCredentials),
  }) as unknown as PublicKeyCredentialRequestOptions;

const credentialJSON = (credential: PublicKeyCredential): Json => {
  const response = credential.response as Partial<
    AuthenticatorAttestationResponse & AuthenticatorAssertionResponse
  >;
  const encoded = (buffer: ArrayBuffer | null | undefined) =>
    buffer ? toBase64(buffer) : undefined;
  return {
    id: credential.id,
    rawId: toBase64(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: response.attestationObject
      ? {
          clientDataJSON: encoded(response.clientDataJSON),
          attestationObject: encoded(response.attestationObject),
          transports: response.getTransports?.() ?? [],
        }
      : {
          clientDataJSON: encoded(response.clientDataJSON),
          authenticatorData: encoded(response.authenticatorData),
          signature: encoded(response.signature),
          userHandle: encoded(response.userHandle),
        },
  };
};

// The browser reports "no passkey here" and "the visitor dismissed it" alike,
// so either way the visitor may need one made.
class NoPasskey extends Error {}

const passkeyError = (thrown: unknown, making: boolean): Error => {
  if (thrown instanceof DOMException && thrown.name === "NotAllowedError") {
    return making
      ? new Error("No passkey was made.")
      : new NoPasskey("No passkey was used.");
  }
  if (thrown instanceof DOMException && thrown.name === "InvalidStateError") {
    return new Error("This device already has a passkey here. Sign in with it.");
  }
  if (thrown instanceof DOMException && thrown.name === "NotSupportedError") {
    return new Error("This browser can't make passkeys.");
  }
  return thrown instanceof Error
    ? thrown
    : new Error("That didn't work. Please try again.");
};

const supported = () =>
  typeof PublicKeyCredential !== "undefined" &&
  !!navigator.credentials?.create;

const signInWithPasskey = async (): Promise<User> => {
  if (!supported()) throw new Error("This browser doesn't support passkeys.");
  const { ticket, options } = await write<{ ticket: string; options: Json }>(
    "signin-options",
    {},
  );
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: requestOptions(options),
    });
  } catch (thrown) {
    throw passkeyError(thrown, false);
  }
  if (!(credential instanceof PublicKeyCredential)) {
    throw new NoPasskey("No passkey was used.");
  }
  try {
    signedIn(
      await write<Signed>("signin", {
        ticket,
        response: credentialJSON(credential),
      }),
    );
  } catch (thrown) {
    // A passkey this site has no account for, left behind by another copy of
    // the site or a reset database.
    if (thrown instanceof RequestError && thrown.status === 404) {
      throw new NoPasskey(thrown.message);
    }
    throw thrown;
  }
  await claimIfPending();
  return state.user!;
};

// A team member hands over the admin token once, as ?comment_token=, to
// claim the team role.
const claimIfPending = async (): Promise<void> => {
  const adminToken = store.get(CLAIM_KEY);
  if (!adminToken || !state.user || state.user.role === "team") return;
  try {
    const { user } = await asUser<{ user: User }>("claim", { adminToken });
    store.set(CLAIM_KEY, null);
    state.user = user;
    emit();
  } catch (thrown) {
    if (thrown instanceof RequestError && thrown.status === 403) {
      store.set(CLAIM_KEY, null);
    }
  }
};

const createPasskey = async (name: string): Promise<User> => {
  if (!supported()) throw new Error("This browser doesn't support passkeys.");
  const adminToken = store.get(CLAIM_KEY);
  const { ticket, options } = await write<{ ticket: string; options: Json }>(
    "register-options",
    { name, ...(adminToken ? { adminToken } : {}) },
  );
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: creationOptions(options),
    });
  } catch (thrown) {
    throw passkeyError(thrown, true);
  }
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("No passkey was made.");
  }
  const signed = await write<Signed>("register", {
    ticket,
    response: credentialJSON(credential),
  });
  if (adminToken) store.set(CLAIM_KEY, null);
  return signedIn(signed);
};

export const signOut = async (): Promise<void> => {
  await asUser("signout").catch(() => undefined);
  signedOut();
};

type Step = "create" | "name";

interface Dialog {
  open(step: Step, problem?: string): Promise<User>;
}

let dialog: Dialog | null = null;

// Shown only when signing in didn't find a passkey. Making one is the one
// thing it asks for.
const buildDialog = (): Dialog => {
  const node = document.createElement("dialog");
  node.className = "account-dialog";
  node.innerHTML = `
    <form method="dialog" class="account-dismiss">
      <button class="account-close" aria-label="Close">&times;</button>
    </form>
    <form class="account-step" data-account-step="create" novalidate>
      <h2 class="account-title" id="account-create-title">Comment with a passkey</h2>
      <p class="account-explain" data-account-explain></p>
      <label class="account-label" for="account-new-name">Your name, as people will see it</label>
      <div class="account-row">
        <input id="account-new-name" name="name" type="text" maxlength="40" autocomplete="nickname" required>
        <button type="submit" class="account-save" data-account-create>Create passkey</button>
      </div>
      <button type="button" class="account-link" data-account-retry>Already have one? Sign in</button>
    </form>
    <form class="account-step" data-account-step="name" novalidate hidden>
      <h2 class="account-title" id="account-name-title">Your name</h2>
      <p class="account-explain">This is the name people see on your comments. Change it whenever you like.</p>
      <div class="account-row">
        <label class="sr-only" for="account-name">Your name</label>
        <input id="account-name" name="name" type="text" maxlength="40" autocomplete="nickname" required>
        <button type="submit" class="account-save">Save</button>
      </div>
      <button type="button" class="account-link" data-account-keep>Keep this name</button>
    </form>
    <p class="account-error" data-account-error role="alert"></p>`;
  node.querySelector("[data-account-explain]")!.textContent =
    `A passkey signs you in to ${window.location.hostname} with your device's Face ID, Touch ID, fingerprint or PIN. ` +
    "No password or email, and it follows you to your other devices.";
  document.body.append(node);

  const createStep = node.querySelector<HTMLFormElement>(
    "[data-account-step=create]",
  )!;
  const newName = createStep.querySelector<HTMLInputElement>(
    "input[name=name]",
  )!;
  const nameStep = node.querySelector<HTMLFormElement>(
    "[data-account-step=name]",
  )!;
  const createButton = createStep.querySelector<HTMLButtonElement>(
    "[data-account-create]",
  )!;
  const retryButton = createStep.querySelector<HTMLButtonElement>(
    "[data-account-retry]",
  )!;
  const nameField = nameStep.querySelector<HTMLInputElement>(
    "input[name=name]",
  )!;
  const saveButton = nameStep.querySelector<HTMLButtonElement>(".account-save")!;
  const error = node.querySelector<HTMLElement>("[data-account-error]")!;
  let waiting: {
    resolve: (user: User) => void;
    reject: (error: Error) => void;
  } | null = null;

  const show = (step: Step) => {
    createStep.hidden = step !== "create";
    nameStep.hidden = step !== "name";
    node.setAttribute(
      "aria-labelledby",
      step === "create" ? "account-create-title" : "account-name-title",
    );
    if (step === "name") nameField.value = state.user?.name ?? "";
  };
  const settle = (user: User) => {
    const done = waiting;
    waiting = null;
    done?.resolve(user);
  };
  const attempt = async (button: HTMLButtonElement, work: () => Promise<void>) => {
    error.textContent = "";
    createButton.disabled = retryButton.disabled = button.disabled = true;
    try {
      await work();
    } catch (thrown) {
      error.textContent =
        thrown instanceof Error
          ? thrown.message
          : "That didn't work. Please try again.";
    } finally {
      createButton.disabled =
        retryButton.disabled =
        saveButton.disabled =
          false;
    }
  };

  createStep.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = newName.value.trim();
    if (!name) {
      error.textContent = "Pick a name first.";
      newName.focus();
      return;
    }
    void attempt(createButton, async () => {
      settle(await createPasskey(name));
      node.close();
    });
  });
  retryButton.addEventListener("click", () =>
    attempt(retryButton, async () => {
      settle(await signInWithPasskey());
      node.close();
    }),
  );
  nameStep.addEventListener("submit", (event) => {
    event.preventDefault();
    if (nameField.value.trim() === state.user?.name) {
      node.close();
      return;
    }
    void attempt(saveButton, async () => {
      const { user } = await asUser<{ user: User }>("rename", {
        name: nameField.value,
      });
      state.user = user;
      emit();
      node.close();
    });
  });
  nameStep
    .querySelector("[data-account-keep]")!
    .addEventListener("click", () => node.close());

  node.addEventListener("close", () => {
    const done = waiting;
    waiting = null;
    done?.reject(new Error("Not signed in."));
  });

  return {
    open(step, problem = "") {
      error.textContent = problem;
      show(step);
      if (!node.open) node.showModal();
      (step === "name" ? nameField : newName).select();
      return new Promise<User>((resolve, reject) => {
        waiting = { resolve, reject };
        if (step === "name" && state.user) settle(state.user);
      });
    },
  };
};

let signingIn: Promise<User> | null = null;

// Browsers show no text of a site's own in their passkey prompt, so the page
// says what it's for beside what was clicked.
const promptHint = (purpose: string, near?: Element | null) => {
  if (!near) return null;
  const hint = document.createElement("p");
  hint.className = "account-hint";
  hint.setAttribute("role", "status");
  hint.textContent = `Choose your passkey to ${purpose}. No passkey yet? Close the prompt and we'll make you one.`;
  near.after(hint);
  return hint;
};

/** Resolves with the signed-in account, asking for a passkey if needed. */
export const requireAccount = (
  purpose = "sign in",
  near?: Element | null,
): Promise<User> => {
  if (state.user) return Promise.resolve(state.user);
  signingIn ??= (async () => {
    const hint = promptHint(purpose, near);
    try {
      return await signInWithPasskey();
    } catch (thrown) {
      hint?.remove();
      dialog ??= buildDialog();
      const problem =
        thrown instanceof NoPasskey
          ? ""
          : thrown instanceof Error
            ? thrown.message
            : "";
      return await dialog.open("create", problem);
    } finally {
      hint?.remove();
    }
  })().finally(() => {
    signingIn = null;
  });
  return signingIn;
};

export const changeName = () => {
  dialog ??= buildDialog();
  return dialog.open("name").catch(() => undefined);
};

export const initAccount = async (): Promise<void> => {
  const url = new URL(window.location.href);
  const adminToken = url.searchParams.get("comment_token");
  if (adminToken) {
    store.set(CLAIM_KEY, adminToken);
    url.searchParams.delete("comment_token");
    history.replaceState(history.state, "", url.toString());
  }

  if (store.get(SESSION_KEY)) {
    try {
      signedIn(await asUser<Signed>("me"));
    } catch {
      // Signed out or unreachable. The page works signed out.
    }
  }
  await claimIfPending();
};
