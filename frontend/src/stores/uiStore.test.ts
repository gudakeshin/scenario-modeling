import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./uiStore";

const reset = () =>
  useUiStore.setState({
    openPanels: [],
    expandedPanel: null,
    periodData: null,
    preloadedInsight: null,
    pendingQuestions: null,
    docManagerInitialTab: null,
    dimensionalPov: {},
    dimensionalMetric: null,
  });

describe("uiStore panel state", () => {
  beforeEach(reset);

  it("togglePanel opens and expands, then closes and collapses", () => {
    const { togglePanel } = useUiStore.getState();

    togglePanel("comparison");
    expect(useUiStore.getState().openPanels).toEqual(["comparison"]);
    expect(useUiStore.getState().expandedPanel).toBe("comparison");

    togglePanel("comparison");
    expect(useUiStore.getState().openPanels).toEqual([]);
    expect(useUiStore.getState().expandedPanel).toBeNull();
  });

  it("keeps insertion order so the chip strip is stable", () => {
    const { openPanel } = useUiStore.getState();
    openPanel("review");
    openPanel("charts");
    openPanel("review"); // re-opening must not reorder
    expect(useUiStore.getState().openPanels).toEqual(["review", "charts"]);
  });

  it("showPanel adds a chip without stealing the expanded slot", () => {
    const { openPanel, showPanel } = useUiStore.getState();
    openPanel("review");
    showPanel("periods");
    expect(useUiStore.getState().openPanels).toEqual(["review", "periods"]);
    expect(useUiStore.getState().expandedPanel).toBe("review");
  });

  it("closePanel only collapses the modal when it closed the expanded panel", () => {
    const { openPanel, showPanel, closePanel } = useUiStore.getState();
    openPanel("review");
    showPanel("charts");

    closePanel("charts");
    expect(useUiStore.getState().expandedPanel).toBe("review");

    closePanel("review");
    expect(useUiStore.getState().expandedPanel).toBeNull();
  });

  it("setExpandedPanel implies the panel is open", () => {
    useUiStore.getState().setExpandedPanel("goalSeek");
    expect(useUiStore.getState().openPanels).toContain("goalSeek");
  });

  it("closing the follow-up panel clears the questions that drive it", () => {
    const { setPendingQuestions, closePanel } = useUiStore.getState();
    setPendingQuestions([
      { id: "q1", question: "?", question_type: "open", options: [] },
    ] as never);
    expect(useUiStore.getState().openPanels).toContain("followUp");

    closePanel("followUp");
    expect(useUiStore.getState().pendingQuestions).toBeNull();
    expect(useUiStore.getState().openPanels).not.toContain("followUp");
  });

  it("clearing pendingQuestions collapses the follow-up modal", () => {
    const { setPendingQuestions, setExpandedPanel } = useUiStore.getState();
    setPendingQuestions([
      { id: "q1", question: "?", question_type: "open", options: [] },
    ] as never);
    setExpandedPanel("followUp");

    useUiStore.getState().setPendingQuestions(null);
    expect(useUiStore.getState().expandedPanel).toBeNull();
  });

  it("closeAllPanels drops derived data along with the panels", () => {
    const { openPanel, setPeriodData, closeAllPanels } = useUiStore.getState();
    openPanel("periods");
    setPeriodData({ periods: [], granularity: "quarterly", pl: {} });
    useUiStore.setState({ docManagerInitialTab: "model", dimensionalMetric: "revenue" });

    closeAllPanels();
    const s = useUiStore.getState();
    expect(s.openPanels).toEqual([]);
    expect(s.expandedPanel).toBeNull();
    expect(s.periodData).toBeNull();
    expect(s.preloadedInsight).toBeNull();
    expect(s.docManagerInitialTab).toBeNull();
    expect(s.dimensionalMetric).toBeNull();
    expect(s.dimensionalPov).toEqual({});
  });
});
