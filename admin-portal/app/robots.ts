import type { MetadataRoute } from "next";

/*
 * The seller/admin portal is entirely private. Disallow all crawling — the
 * public, indexable content lives on the marketing site (apex domain).
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
