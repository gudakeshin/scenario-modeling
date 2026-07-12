"use client";

import { Suspense } from "react";
import DataModelsClient from "@/components/data/DataModelsClient";

export default function ConnectionsPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center text-sm text-[var(--text-muted)]">
          Loading…
        </main>
      }
    >
      <DataModelsClient />
    </Suspense>
  );
}
