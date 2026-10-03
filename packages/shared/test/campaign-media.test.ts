import { describe, expect, it } from "vitest";
import { parseVideoUrl, pdfLabel, videoEmbedUrl, videoFromCid, videoCid, videoWatchUrl } from "../src/campaign-media.js";

describe("parseVideoUrl", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s", "youtube", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?si=abc", "youtube", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ"],
    ["  https://vimeo.com/76979871  ", "vimeo", "76979871"],
    ["https://player.vimeo.com/video/76979871?h=1", "vimeo", "76979871"],
  ])("%s", (url, provider, id) => expect(parseVideoUrl(url)).toEqual({ provider, id }));

  it.each([
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ", // not https
    "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ", // look-alike host
    "https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ",
    "https://user:pw@www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ%22onerror",
    "https://www.youtube.com/channel/UC123",
    "https://youtu.be/dQw4w9WgXcQ/extra",
    "https://vimeo.com/channels/staffpicks/76979871",
    "https://vimeo.com/abc",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s", (url) => expect(parseVideoUrl(url)).toBeNull());

  it("round-trips through the stored cid and builds privacy-friendly URLs", () => {
    const yt = parseVideoUrl("https://youtu.be/dQw4w9WgXcQ")!;
    expect(videoFromCid(videoCid(yt))).toEqual(yt);
    expect(videoEmbedUrl(yt)).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    expect(videoWatchUrl(yt)).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const vm = parseVideoUrl("https://vimeo.com/76979871")!;
    expect(videoEmbedUrl(vm)).toBe("https://player.vimeo.com/video/76979871?dnt=1");
    expect(videoFromCid("youtube:<script>")).toBeNull();
  });
});

describe("pdfLabel", () => {
  it("keeps a readable name, drops folders and control characters, ends in .pdf", () => {
    expect(pdfLabel("Project plan 2026.pdf")).toBe("Project plan 2026.pdf");
    expect(pdfLabel("C:\\Users\\Jana\\Desktop\\Budget.PDF")).toBe("Budget.pdf");
    expect(pdfLabel("../../etc/passwd")).toBe("passwd.pdf");
    expect(pdfLabel("evil\u202Efdp.exe")).toBe("evilfdp.exe.pdf");
    expect(pdfLabel("")).toBe("document.pdf");
    expect(pdfLabel("a".repeat(300) + ".pdf")).toHaveLength(120);
  });
});
