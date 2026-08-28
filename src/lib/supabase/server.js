import "server-only";

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function requirePublicSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !key) {
    throw new Error("Supabase public configuration is missing.");
  }

  return { url, key };
}

export async function createSupabaseServerClient(response) {
  const cookieStore = await cookies();
  const { url, key } = requirePublicSupabaseConfig();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet, headersToSet) {
        for (const { name, value, options } of cookiesToSet) {
          if (response) {
            response.cookies.set(name, value, options);
            continue;
          }

          try {
            cookieStore.set(name, value, options);
          } catch {
            // Server Components cannot write cookies. The root Proxy refreshes
            // sessions before rendering and persists them on the response.
          }
        }

        if (response) {
          for (const [name, value] of Object.entries(headersToSet)) {
            response.headers.set(name, value);
          }
        }
      },
    },
  });
}
