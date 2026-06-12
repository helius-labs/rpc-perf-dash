import type { ReactNode } from "react";
import type { Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import NavLinks from "@/components/NavLinks";
import MobileMenu from "@/components/MobileMenu";
import HeaderStatus from "@/components/HeaderStatus";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-sans-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono-geist", display: "swap" });

export const metadata = {
  title: "Solana RPC Benchmark",
  description: "Continuous, regional, non-gameable RPC benchmark",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        <header className="sticky top-0 z-30 flex items-center gap-7 max-w-[1240px] w-full mx-auto px-10 py-[22px] bg-bg/90 backdrop-blur-md border-b border-line max-[640px]:px-5 max-[640px]:py-[18px] max-[640px]:gap-4 max-[640px]:bg-bg max-[640px]:backdrop-blur-none">
          <Link
            href="/"
            className="flex items-center gap-3 shrink-0 hover:no-underline"
            aria-label="Solana RPC Benchmark — home"
          >
            <span className="flex flex-col leading-[1.25]">
              <span className="font-geistmono text-[14px] font-semibold tracking-[-0.01em] text-fg whitespace-nowrap">
                Solana RPC Benchmark
              </span>
            </span>
          </Link>
          <NavLinks />
          <div className="ml-auto flex items-center gap-4 shrink-0">
            <HeaderStatus />
            <a
              href="https://github.com/helius-labs/rpc-perf-dash"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View source on GitHub"
              title="View source on GitHub"
              className="text-muted inline-flex hover:text-fg hover:no-underline max-[640px]:hidden"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-1.92c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.12 3.06.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.26 5.68.41.35.78 1.05.78 2.12v3.14c0 .31.21.66.79.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
              </svg>
            </a>
            <MobileMenu />
          </div>
        </header>
        <main className="max-w-[1240px] w-full mx-auto px-10 pt-3 pb-16 max-[640px]:px-5 max-[640px]:pt-0 max-[640px]:pb-12">
          {children}
        </main>
      </body>
    </html>
  );
}
