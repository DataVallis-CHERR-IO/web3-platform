// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CampaignCard } from "@cherrio/ui";

afterEach(cleanup);

describe("CampaignCard status chip", () => {
  it("renders exactly one status chip over the media", () => {
    const { container } = render(
      <CampaignCard
        title="Clean water"
        org="WaterAid"
        status="live"
        statusLabel="Live"
        raised={{ eurCents: 100n }}
        target={{ eurCents: 1000n }}
      />,
    );
    const media = container.querySelector(".ch-card-media");
    expect(media).not.toBeNull();
    const chips = media!.querySelectorAll(".ch-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain("Live");
  });

  it("renders no chip when no status is given", () => {
    const { container } = render(
      <CampaignCard title="t" org="o" raised={{ eurCents: 0n }} target={{ eurCents: 1n }} />,
    );
    expect(container.querySelectorAll(".ch-chip")).toHaveLength(0);
  });
});
