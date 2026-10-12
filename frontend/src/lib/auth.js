const USER_KEY = "user";

function canLocalStorage() {
  return typeof window !== "undefined";
}

/**
 * The access and refresh tokens live in HttpOnly cookies, so there is nothing to
 * read here on purpose: JavaScript cannot reach them, which is the whole point
 * (master plan section 8, "don't store authentication tokens in plain
 * localStorage"). Only the display profile is kept, for the avatar and name.
 */
export function setSession(user) {
  if (!canLocalStorage()) return;
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  else localStorage.removeItem(USER_KEY);
}

export function clearSession() {
  if (!canLocalStorage()) return;
  localStorage.removeItem(USER_KEY);
}

export function getUser() {
  if (!canLocalStorage()) return null;
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}
