"use client";

import { Toaster } from "@/components/ui/sonner";

/**
 * Providers mounted by the root layout.
 *
 * There is no theme provider here on purpose: the app is fixed to light mode, and
 * `next-themes` injects its state as a real React `<script>` element, which React 19
 * reports as "Scripts inside React components are never executed". The dark-mode
 * variant still exists in `globals.css` for components that opt in later, but
 * nothing flips it today, so the injected script bought nothing.
 */
export function Providers({ children }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}
