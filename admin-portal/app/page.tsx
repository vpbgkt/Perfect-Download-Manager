import { redirect } from "next/navigation";

/**
 * Portal root. Unauthenticated visitors are sent to `/login` by the middleware
 * before this runs; authenticated visitors are forwarded to the dashboard.
 */
export default function Home() {
  redirect("/dashboard");
}
