"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, LogOut, Shield } from "lucide-react";
import { toast } from "sonner";
import { logout, logoutAll } from "@/lib/api";
import { clearSession } from "@/lib/auth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function initials(name) {
  const chars = String(name || "?")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, "");
  const parts = chars.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts
    .slice(0, 2)
    .map((w) => (w[0] || "").toUpperCase())
    .join("");
}

/**
 * Account menu for the dashboard header.
 *
 * The signed-in identity used to be a "Log out" button next to a line of text,
 * which is neither a profile nor somewhere to put a second session action. This
 * collapses the account into one avatar trigger and keeps both real
 * capabilities behind it: end this device's session, or revoke every session
 * the account holds.
 *
 * `user` is the display profile from localStorage (`{ id, name, email }`) --
 * tokens live in HttpOnly cookies and never reach this component.
 */
export default function UserMenu({ user }) {
  const router = useRouter();
  const [busy, setBusy] = useState(null);

  async function signOut(everywhere) {
    if (busy) return;
    if (everywhere && !window.confirm("Sign out of every device and browser?")) return;
    setBusy(everywhere ? "all" : "one");
    try {
      // Revoke server-side first, so a copy of the cookie is dead the moment
      // the user walks away from this machine.
      if (everywhere) await logoutAll();
      else await logout();
      clearSession();
      router.push("/login");
    } catch (err) {
      toast.error(err?.message || "Could not sign out");
      setBusy(null);
    }
  }

  if (!user) {
    return <div className="size-9 animate-pulse rounded-full bg-zinc-200" />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="group flex h-9 items-center gap-1.5 rounded-full border border-zinc-200 bg-white pr-2 pl-1 outline-none transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-blue-400"
          aria-label={`Account menu for ${user.name}`}
        >
          <Avatar className="size-7 border border-zinc-100">
            <AvatarFallback className="bg-blue-600 text-[11px] font-semibold text-white">
              {initials(user.name)}
            </AvatarFallback>
          </Avatar>
          <ChevronDown className="size-3.5 text-zinc-400 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="w-64">
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-3 px-2 py-2.5">
            <Avatar className="size-10 border border-zinc-100">
              <AvatarFallback className="bg-blue-600 text-sm font-semibold text-white">
                {initials(user.name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-zinc-900">{user.name}</p>
              <p className="truncate text-xs text-zinc-500">{user.email}</p>
            </div>
          </div>
        </DropdownMenuLabel>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          disabled={!!busy}
          data-testid="logout"
          onSelect={() => signOut(false)}
        >
          <LogOut />
          {busy === "one" ? "Signing out..." : "Log out"}
        </DropdownMenuItem>

        <DropdownMenuItem
          variant="destructive"
          disabled={!!busy}
          onSelect={() => signOut(true)}
        >
          <Shield />
          {busy === "all" ? "Signing out..." : "Sign out everywhere"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
