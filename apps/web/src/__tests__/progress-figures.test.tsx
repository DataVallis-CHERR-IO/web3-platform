// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Progress } from "@cherrio/ui";

afterEach(cleanup);

describe("Progress figures row", () => {
  it("shows the raised and target figures by default", () => {
    const { container } = render(<Progress raised={{ usdc: 1_250_000_000n }} target={{ usdc: 10_000_000_000n }} currency="USDC" />);
    const figures = container.querySelector(".ch-progress-figures");
    expect(figures).not.toBeNull();
    expect(figures!.textContent).toContain("1,250");
  });

  it("hides the figures row with showFigures={false} but keeps the bar and meta", () => {
    const { container, getByRole } = render(
      <Progress
        raised={{ usdc: 1_250_000_000n }}
        target={{ usdc: 10_000_000_000n }}
        currency="USDC"
        showFigures={false}
        barLabel="12% of the target raised"
        meta="12% raised · 3 donors"
      />,
    );
    expect(container.querySelector(".ch-progress-figures")).toBeNull();
    expect(container.textContent).not.toContain("1,250");
    expect(getByRole("progressbar").getAttribute("aria-valuenow")).toBe("13");
    expect(container.querySelector(".ch-progress-meta")!.textContent).toContain("12% raised");
  });

  it("draws no fill at 0 % (its border would be a stray stub) and a fill above 0 %", () => {
    const empty = render(<Progress raised={{ usdc: 0n }} target={{ usdc: 10_000_000_000n }} currency="USDC" />);
    expect(empty.container.querySelector(".ch-bar-fill")).toBeNull();
    cleanup();
    const some = render(<Progress raised={{ usdc: 100_000_000n }} target={{ usdc: 10_000_000_000n }} currency="USDC" />);
    expect((some.container.querySelector(".ch-bar-fill") as HTMLElement).style.width).toBe("1%");
  });
});
