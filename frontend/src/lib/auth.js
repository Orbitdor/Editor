const TOKEN_KEY = "token";
const USER_KEY = "user";

function canLocalStorage() {
  return typeof window !== "undefined";
}

export function getToken() {
  return canLocalStorage() ? localStorage.getItem(TOKEN_KEY) : null;
}

export function setSession(token, user) {
  if (!canLocalStorage()) return;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  if (!canLocalStorage()) return;
  localStorage.removeItem(TOKEN_KEY);
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