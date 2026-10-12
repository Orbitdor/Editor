"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { completeGoogleSignIn } from "@/lib/api";
import { setSession } from "@/lib/auth";

/**
 * Landing point for the Google sign-in redirect (master plan section 9).
 *
 * The backend sends the browser here with a single-use `ticket` rather than a
 * token in the URL, so nothing sensitive sits in history or a referrer. This page
 * trades that ticket for the session over POST.
 *
 * The Suspense boundary is required because `useSearchParams` cannot be read
 * while the page is statically prerendered.
 */
export default function GoogleCallbackPage() {
  return (
    <Suspense fallback={<Pending />}>
      <GoogleCallback />
    </Suspense>
  );
}

function Pending({ label = "Finishing sign-in..." }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-zinc-500">
      <Loader2 className="h-5 w-5 animate-spin" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

function GoogleCallback() {
  const router = useRouter();
  const params = useSearchParams();
  const ticket = params.get("ticket");
  const oauthError = params.get("error");
  // Derived during render rather than assigned in the effect: whether the link is
  // already unusable is known here, so there is nothing to synchronise.
  const [error, setError] = useState(
    oauthError
      ? `Google sign-in failed: ${oauthError}`
      : ticket
        ? ""
        : "This sign-in link is incomplete. Please try again."
  );
  // React 18 runs effects twice in development, and redeeming a ticket twice
  // fails by design. A ref keeps the second run from spending it again.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    // Both unusable-link cases are already on screen from the initial state.
    if (!ticket || oauthError) return;

    let cancelled = false;
    completeGoogleSignIn(ticket)
      .then((data) => {
        if (cancelled) return;
        setSession(data.user);
        toast.success(`Welcome${data.isNewUser ? "" : " back"}, ${data.user.name}`);
        // `returnTo` is validated server-side to be a path on this site.
        router.replace(data.returnTo || "/");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
      });

    return () => {
      cancelled = true;
    };
  }, [ticket, oauthError, router]);

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
        <p className="text-sm text-red-600">{error}</p>
        <button
          type="button"
          onClick={() => router.replace("/login")}
          className="text-sm font-medium text-blue-600 hover:underline"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  return <Pending />;
}