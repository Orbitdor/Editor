"use client";

import { Toaster as Sonner } from "sonner";

function Toaster({ ...props }) {
  return (
    <Sonner
      // Fixed to light: the app no longer mounts a theme provider, so reading a
      // theme would fall back to a default that nothing can change.
      theme="light"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        }
      }
      {...props}
    />
  );
}

export { Toaster };
