"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const links = [
  { href: "/", label: "Today" },
  { href: "/posts", label: "Source feed" },
  { href: "/ideas", label: "Idea archive" },
  { href: "/settings", label: "Settings" },
];

function isCurrent(pathname, href) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  if (pathname === "/login" || pathname.startsWith("/auth/")) {
    return null;
  }

  async function signOut() {
    setSigningOut(true);
    await createSupabaseBrowserClient().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <header className="border-b border-[var(--line)] bg-[rgb(251_250_246/0.86)] backdrop-blur-xl">
      <div className="shell flex min-h-18 flex-wrap items-center justify-between gap-3 py-3 sm:flex-nowrap sm:gap-5">
        <Link href="/" className="focus-ring group flex items-center gap-3 rounded-lg">
          <span className="grid size-9 place-items-center rounded-xl bg-[var(--ink)] text-[var(--moss-bright)] shadow-sm transition-transform group-hover:-rotate-3">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="none">
              <path d="M5 16.5 9.2 8l3.1 5 2.5-7L19 16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 19h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span>
            <span className="block text-[0.94rem] font-bold tracking-[-0.02em]">Signal Foundry</span>
            <span className="hidden text-[0.66rem] font-medium text-[var(--ink-soft)] sm:block">Private opportunity desk</span>
          </span>
        </Link>

        <nav aria-label="Primary navigation" className="order-3 flex w-full items-center justify-between gap-1 rounded-xl border border-[var(--line)] bg-white/60 p-1 sm:order-none sm:w-auto">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isCurrent(pathname, link.href) ? "page" : undefined}
              className={`focus-ring rounded-lg px-2 py-2 text-xs font-semibold transition-colors sm:px-3 sm:text-sm ${
                isCurrent(pathname, link.href)
                  ? "bg-[var(--ink)] text-white"
                  : "text-[var(--ink-soft)] hover:bg-white hover:text-[var(--ink)]"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          className="focus-ring rounded-lg px-2 py-2 text-xs font-semibold text-[var(--ink-soft)] transition-colors hover:bg-white hover:text-[var(--ink)] disabled:opacity-50"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </header>
  );
}
