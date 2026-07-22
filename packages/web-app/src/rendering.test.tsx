import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("safe worker text rendering", () => {
  it("renders hostile worker-reported text as escaped plain text", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>steal()</script>';
    const markup = renderToStaticMarkup(<pre>{hostile}</pre>);
    expect(markup).not.toContain("<script>"); expect(markup).not.toContain("<img"); expect(markup).toContain("&lt;script&gt;");
  });
});
