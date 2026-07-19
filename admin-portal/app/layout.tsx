import type { Metadata } from "next";
import "./globals.css";

/*
 * The portal is an authenticated application served at
 * seller.perfectdownloadmanager.com. It must never be indexed by search
 * engines — SEO belongs to the public marketing site on the apex domain.
 */
export const metadata: Metadata = {
  title: {
    default: "PDM Seller & Admin Portal",
    template: "%s · PDM Portal",
  },
  description: "License, release, and SEO administration for Perfect Download Manager.",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
