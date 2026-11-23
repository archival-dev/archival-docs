const ATTEMPTS = 4;
const BASE_DELAY_MS = 500;

const transient = (status) => status === 429 || status >= 500;

// Resolves with the first response that is not a 429 or 5xx, or with the last
// one once the attempts run out; a request that never gets an answer rejects.
export const fetchWithRetry = async (url) => {
  for (let attempt = 1; ; attempt++) {
    const last = attempt === ATTEMPTS;
    let response;
    try {
      response = await fetch(url);
    } catch (e) {
      if (last) {
        throw new Error(`fetching ${url}: ${e.cause?.message ?? e.message}`);
      }
    }
    if (response && (last || !transient(response.status))) {
      return response;
    }
    await response?.body?.cancel();
    const reason = response ? response.status : "no response";
    console.warn(`${url}: ${reason}, attempt ${attempt} of ${ATTEMPTS}`);
    await new Promise((resolve) =>
      setTimeout(resolve, BASE_DELAY_MS * 2 ** (attempt - 1)),
    );
  }
};
