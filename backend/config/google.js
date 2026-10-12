/**
 * Google integration configuration (master plan sections 29-31).
 *
 * The plan is explicit about one thing: authentication OAuth and API OAuth must
 * not be mixed. Signing in with Google proves who the user is and asks for
 * nothing but an email. Connecting Drive or Docs grants access to their files
 * and is a separate, revocable grant stored as a `GoogleConnection`. So the
 * scopes below are grouped per purpose, and a connect request only ever asks
 * for the group it needs.
 *
 * No credentials are present in development, so every entry point has a mock
 * path: the routes validate, authorise, persist and shape exactly as they would
 * in production, and only the call to Google is faked.
 */

const pick = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return "";
};

/**
 * Scope groups. `auth` is for sign-in only; the rest are API grants, each
 * requested separately so the consent screen stays honest about what is used.
 */
export const GOOGLE_SCOPE_GROUPS = {
  auth: {
    label: "Sign in with Google",
    description: "Confirms your email address. No access to your files.",
    scopes: ["openid", "email", "profile"],
  },
  drive: {
    label: "Google Drive",
    description: "List, import and export files. Needed for Drive import and export.",
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  },
  docs: {
    label: "Google Docs",
    description: "Read and create Google Docs. Needed for document import and export.",
    scopes: ["https://www.googleapis.com/auth/documents"],
  },
  speech: {
    label: "Google Cloud Speech-to-Text",
    description: "Transcribe dictation with Google's speech service.",
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  },
  vision: {
    label: "Google Cloud Vision",
    description: "Extract text from images with Google's vision service.",
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  },
};

export const SCOPE_GROUP_NAMES = Object.keys(GOOGLE_SCOPE_GROUPS);

/** All API scopes a "connect everything" request would ask for. */
export const ALL_API_SCOPES = Array.from(
  new Set(
    SCOPE_GROUP_NAMES.filter((name) => name !== "auth")
      .flatMap((name) => GOOGLE_SCOPE_GROUPS[name].scopes)
  )
);

/** Google Docs API mime type, used to tell Docs files apart from other Drive files. */
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
/** Mime type for a file exported from this editor and stored in Drive. */
export const EXPORTED_HTML_MIME = "text/html";

export function googleConfig() {
  const baseUrl = pick("GOOGLE_BASE_URL") || "https://www.googleapis.com";
  const authUrl = pick("GOOGLE_AUTH_URL") || "https://accounts.google.com/o/oauth2/v2/auth";
  const tokenUrl = pick("GOOGLE_TOKEN_URL") || "https://oauth2.googleapis.com/token";
  const revokeUrl = pick("GOOGLE_REVOKE_URL") || "https://oauth2.googleapis.com/revoke";
  const redirectUri =
    pick("GOOGLE_REDIRECT_URI") || `${pick("API_PUBLIC_URL", "PUBLIC_API_URL") || "http://localhost:5000"}/api/v1/integrations/google/callback`;
  // Sign-in and connect have separate callbacks on purpose. Google matches the
  // redirect URI exactly, so pointing sign-in at the connect callback would send
  // every sign-in to the wrong route, where it would be rejected as a flow
  // mismatch.
  const signInRedirectUri =
    pick("GOOGLE_SIGN_IN_REDIRECT_URI") || `${pick("API_PUBLIC_URL", "PUBLIC_API_URL") || "http://localhost:5000"}/api/v1/auth/google/callback`;
  // Where the browser is sent back to after the callback.
  const frontendUrl = (pick("GOOGLE_FRONTEND_URL", "FRONTEND_URL", "NEXT_PUBLIC_APP_URL") || "http://localhost:3000").replace(/\/+$/, "");

  return {
    clientId: pick("GOOGLE_CLIENT_ID"),
    clientSecret: pick("GOOGLE_CLIENT_SECRET"),
    redirectUri,
    signInRedirectUri,
    frontendUrl,
    authUrl,
    tokenUrl,
    revokeUrl,
    driveUrl: `${baseUrl}/drive/v3`,
    docsUrl: `${baseUrl}/docs/v1`,
    // Google's access tokens last an hour; refresh well before that so a long
    // upload never fails on an expired token mid-way.
    refreshSkewMs: 60_000,
    timeoutMs: Number(pick("GOOGLE_TIMEOUT_MS")) || 30000,
    // Lets the flow run offline and in tests without credentials.
    allowMock: (pick("GOOGLE_ALLOW_MOCK") || "true").toLowerCase() !== "false",
  };
}

/** True when real OAuth credentials are present. */
export function isGoogleConfigured(cfg = googleConfig()) {
  return Boolean(cfg.clientId && cfg.clientSecret);
}

/**
 * Resolve a requested group (or list of groups) into a deduplicated scope list.
 *
 * @param {string|string[]} groups
 * @returns {{scopes: string[], unknown: string[]}}
 */
export function resolveScopes(groups) {
  const requested = Array.isArray(groups) ? groups : [groups];
  const scopes = new Set();
  const unknown = [];

  for (const name of requested) {
    const group = GOOGLE_SCOPE_GROUPS[name];
    if (!group) {
      unknown.push(name);
      continue;
    }
    group.scopes.forEach((scope) => scopes.add(scope));
  }

  return { scopes: [...scopes], unknown };
}

/**
 * Capability snapshot for the Integration Center and the sign-in button.
 *
 * `mock` is what makes the UI testable with no credentials: the flow runs end to
 * end and only the network call to Google is simulated.
 */
export function googleStatus() {
  const cfg = googleConfig();
  return {
    configured: isGoogleConfigured(cfg),
    mock: !isGoogleConfigured(cfg) && cfg.allowMock,
    signInEnabled: isGoogleConfigured(cfg) || cfg.allowMock,
    redirectUri: cfg.redirectUri,
    groups: SCOPE_GROUP_NAMES.map((name) => ({
      id: name,
      ...GOOGLE_SCOPE_GROUPS[name],
    })),
  };
}

/** `prompt=consent` forces a refresh token on reconnect, which Google omits otherwise. */
export function promptForAccessType(groups) {
  return SCOPE_GROUP_NAMES.some((name) => groups.includes(name) && name !== "auth")
    ? "consent"
    : "select_account";
}
