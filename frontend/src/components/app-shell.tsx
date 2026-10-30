"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AccountMenu } from "@/components/account-menu";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const active = pathname.startsWith("/cases");

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[244px_minmax(0,1fr)]">
      <aside className="hidden border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <Link href="/cases" className="flex h-[76px] items-center gap-3 border-b border-slate-100 px-7 no-underline">
          <span className="grid size-9 place-items-center rounded-xl bg-emerald-900 text-sm font-bold text-white">A</span>
          <span className="text-lg font-semibold tracking-tight text-slate-900">anvil<span className="text-emerald-800">.</span></span>
        </Link>
        <div className="px-4 pt-7">
          <p className="eyebrow px-3 text-[10px] font-semibold text-slate-400">Workspace</p>
          <Link
            href="/cases"
            aria-current={active ? "page" : undefined}
            className={`mt-3 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium no-underline ${active ? "bg-emerald-50 text-emerald-900" : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"}`}
          >
            <span className="size-1.5 rounded-full bg-current" />
            Credit cases
          </Link>
        </div>
        <div className="mt-auto border-t border-slate-100 p-6">
          <p className="text-xs font-semibold text-slate-700">Evidence-first underwriting</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">A clear view of every credit decision.</p>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-10 flex min-h-[76px] items-center justify-between gap-4 border-b border-slate-200 bg-white/95 px-5 backdrop-blur md:px-9">
          <div className="flex items-center gap-3 lg:hidden">
            <span className="grid size-8 place-items-center rounded-lg bg-emerald-900 text-sm font-bold text-white">A</span>
            <span className="font-semibold tracking-tight">anvil<span className="text-emerald-800">.</span></span>
          </div>
          <p className="hidden text-sm text-slate-500 lg:block">Credit operations <span className="mx-2 text-slate-300">/</span> Cases</p>
          <AccountMenu />
        </header>
        <main id="main-content" className="mx-auto w-full max-w-[1440px] px-5 py-8 md:px-9 md:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}
