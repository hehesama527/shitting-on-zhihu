"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type ProductNavItem = {
  href: string;
  label: string;
};

type ProductShellProps = {
  tone: "zhihu" | "twitter" | "images" | "models" | "hotspots" | "video";
  kicker: string;
  title: string;
  description: string;
  navItems: ProductNavItem[];
  homeHref?: string;
  homeLabel?: string;
  switchHref: string;
  switchLabel: string;
  children: ReactNode;
};

export function ProductShell({
  tone,
  kicker,
  title,
  description,
  navItems,
  homeHref,
  homeLabel,
  switchHref,
  switchLabel,
  children
}: ProductShellProps) {
  const pathname = usePathname();

  return (
    <div className={`shell shell--${tone}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-kicker">{kicker}</span>
          <h1>{title}</h1>
          <p>{description}</p>
          {homeHref && homeLabel ? (
            <Link href={homeHref} className="brand-home-link">
              {homeLabel}
            </Link>
          ) : null}
        </div>

        <nav className="nav">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={isActivePath(pathname, item.href) ? "nav-link nav-link--active" : "nav-link"}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="switch-panel">
          <p className="helper-text">产品切换</p>
          <div className="switch-links">
            <Link href="/">工作台</Link>
            <Link href={switchHref}>{switchLabel}</Link>
          </div>
        </div>
      </aside>

      <main className="content">{children}</main>
    </div>
  );
}

function isActivePath(pathname: string, href: string) {
  if (href === "/") {
    return pathname === "/";
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}
