import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders bold markdown as strong", () => {
    render(<MarkdownContent content="Hello **world**" />);
    const strong = screen.getByText("world");
    expect(strong.tagName).toBe("STRONG");
  });

  it("sanitizes script tags so they do not execute", () => {
    const { container } = render(
      <MarkdownContent content={'Safe <script>alert("xss")</script> text'} />
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toMatch(/<script/i);
    expect(container.textContent).toContain("Safe");
    expect(container.textContent).toContain("text");
  });

  it("strips onerror handlers from raw HTML", () => {
    const { container } = render(
      <MarkdownContent content={'<img src=x onerror="alert(1)" alt="bad" />'} />
    );
    const img = container.querySelector("img");
    if (img) {
      expect(img.getAttribute("onerror")).toBeNull();
    }
    expect(container.innerHTML).not.toMatch(/onerror/i);
  });
});
