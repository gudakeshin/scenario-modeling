import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScopeBadge } from "./ParameterReview";

describe("ScopeBadge", () => {
  it("shows catalog names and preserves dimension context", () => {
    render(
      <ScopeBadge
        memberScope={{ region: "emea" }}
        memberCatalog={{ region: [{ id: "emea", name: "EMEA" }] }}
      />,
    );
    expect(screen.getByText("region: EMEA")).toBeInTheDocument();
  });
});
