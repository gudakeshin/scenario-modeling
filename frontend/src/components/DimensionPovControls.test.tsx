import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { DimensionPovControls } from "./DimensionPovControls";
import { useUiStore } from "@/stores/uiStore";

describe("DimensionPovControls", () => {
  beforeEach(() => {
    useUiStore.setState({ dimensionalPov: {}, dimensionalMetric: null });
  });

  it("renders member labels from the catalog", () => {
    render(
      <DimensionPovControls dimensional={{
        dimensions: [{ id: "region", name: "Region", type: "generic" }],
        breakdowns: { revenue: { region: { emea: 42 } } },
        member_catalog: { region: [{ id: "emea", name: "EMEA" }] },
      }} />,
    );
    expect(screen.getByRole("option", { name: "EMEA" })).toHaveValue("emea");
    expect(screen.getAllByText("EMEA")).toHaveLength(2);
  });
});
