import { NextResponse } from "next/server";
import { isConfiguredOwner } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function safeDestination(value, origin) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  try {
    const target = new URL(value, origin);
    if (target.origin !== origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

function loginErrorUrl(request) {
  const url = new URL("/login", request.url);
  url.searchParams.set("error", "invalid_link");
  return url;
}

export async function GET(request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const destination = safeDestination(requestUrl.searchParams.get("next"), requestUrl.origin);
  const response = NextResponse.redirect(new URL(destination, request.url));

  if (!code) {
    return NextResponse.redirect(loginErrorUrl(request));
  }

  const supabase = await createSupabaseServerClient(response);
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    response.headers.set("location", loginErrorUrl(request).toString());
    return response;
  }

  const { data, error: claimsError } = await supabase.auth.getClaims();
  if (claimsError || !isConfiguredOwner(data?.claims?.sub)) {
    await supabase.auth.signOut();
    response.headers.set("location", loginErrorUrl(request).toString());
    return response;
  }

  return response;
}
