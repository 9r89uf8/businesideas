import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

function publicSupabaseConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    key: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  };
}

function copyAuthState(source, target) {
  for (const cookie of source.cookies.getAll()) {
    target.cookies.set(cookie);
  }

  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = source.headers.get(header);
    if (value) target.headers.set(header, value);
  }

  return target;
}

export async function proxy(request) {
  const pathname = request.nextUrl.pathname;

  if (
    pathname.startsWith("/.well-known/workflow/") ||
    pathname.startsWith("/api/cron/")
  ) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });
  const { url, key } = publicSupabaseConfig();

  if (!url || !key) {
    return response;
  }

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headersToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }

        response = NextResponse.next({ request });

        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }

        for (const [name, value] of Object.entries(headersToSet || {})) {
          response.headers.set(name, value);
        }
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  const isOwner = userId && userId === process.env.OWNER_USER_ID;
  const isPublic = pathname === "/login" || pathname.startsWith("/auth/");
  const isApi = pathname.startsWith("/api/");

  if (!isOwner && !isPublic && !isApi) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return copyAuthState(response, NextResponse.redirect(loginUrl));
  }

  if (isOwner && pathname === "/login") {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = "/";
    dashboardUrl.search = "";
    return copyAuthState(response, NextResponse.redirect(dashboardUrl));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.well-known/workflow/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
