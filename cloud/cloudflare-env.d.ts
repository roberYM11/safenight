declare namespace Cloudflare {
  interface Env {
    SAFENIGHT_SDOT_API_KEY?: string;
    SAFENIGHT_COLLECT_AUTH_TOKEN?: string;
    SAFENIGHT_PLACE_SEARCH_URL?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
