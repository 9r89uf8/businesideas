import { NextResponse } from "next/server";
import { isConfiguredOwner } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;

  if (error || !userId) {
    return NextResponse.json(
      { error: "An authenticated session is required." },
      { status: 401 },
    );
  }

  if (!isConfiguredOwner(userId)) {
    const response = NextResponse.json(
      { error: "This account is not authorized." },
      { status: 403 },
    );
    const signOutClient = await createSupabaseServerClient(response);
    await signOutClient.auth.signOut({ scope: "local" });
    return response;
  }

  return NextResponse.json({ ok: true });
}
