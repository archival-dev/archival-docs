// Definitions from the esbuild config. These must be defined at build time, as
// they will be baked into the app.

declare const DEV: boolean;
/** Origin of the editor: the template gallery, templates.json and thumbnails. */
declare const EDITOR_URL: string;
declare const API_URL: string;
declare const TURNSTILE_SITE_KEY: string;
/** Origin of the Val Town val that stores comments on updates. */
declare const COMMENTS_URL: string;
