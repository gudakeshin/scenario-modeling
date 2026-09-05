"use client";

import { Suspense } from "react";
import LoginClient from "./LoginClient";

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="min-h-screen flex items-center justify-center">Loading…</main>}>
      <LoginClient />
    </Suspense>
  );
}
