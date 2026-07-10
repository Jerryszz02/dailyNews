import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { sourceLabel } from "./App";
import { App } from "./App";
import { newsSources } from "./config/sources";

describe("sourceLabel", () => {
  it("returns a Chinese display label for every enabled source", () => {
    for (const source of newsSources.filter((item) => item.enabled)) {
      expect(sourceLabel(source.name)).toMatch(/[\u4e00-\u9fff]/);
    }
  });
});

describe("App shell", () => {
  it("renders one category navigation and the global news search", () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup.match(/aria-label="分类导航"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="搜索新闻"');
    expect(markup).not.toContain('class="sidebar"');
  });
});
