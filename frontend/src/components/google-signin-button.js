"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { startGoogleSignIn } from "@/lib/api";

/**
 * "Continue with Google" button (master plan section 9).
 *
 * Sign-in is a redirect, not a fetch: Google owns the credential step, so the
 * browser leaves for the consent screen and comes back through
 * `/auth/google/callback`.
 *
 * When the server has no OAuth credentials it reports `mock: true`. The mock
 * still returns a Google URL, which would fail in a real browser, so the button
 * says so instead of sending the user to a broken consent screen.
 */
export function GoogleSignInButton({ label = "Continue with Google", className = "" }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const { url, mock } = await startGoogleSignIn();
      if (mock) {
        toast.info("Google sign-in needs server credentials.", {
          description: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to switch it on.",
        });
        setLoading(false);
        return;
      }
      router.push(url);
    } catch (err) {
      toast.error(err.message);
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className={`flex w-full items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800 ${className}`}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <GoogleMark />}
      {loading ? "Redirecting..." : label}
    </button>
  );
}

/** Google's four-colour G, drawn inline so there is no icon dependency. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.9z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9H1.4v3.1A12 12 0 0 0 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.4 14.4a7.2 7.2 0 0 1 0-4.6V6.7H1.4a12 12 0 0 0 0 10.8l4-3.1z"
      />
      <path
        fill="#EA4335"
        d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.7l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"
      />
    </svg>
  );
}

export default GoogleSignInButton;