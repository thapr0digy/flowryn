import { describe, expect, test } from "bun:test";
import { probeHelpers, QA_PROBE, QA_PROBE_LIST_MAX, QA_TOKENS_GLOBAL } from "../../src/skills/qa-probe.ts";

/**
 * The visual QA probe (src/skills/qa-probe.ts): its helpers are the same
 * JavaScript the page runs, so these tests check the code chrome-devtools-axi
 * evaluates. The DOM walk needs a browser and is not run here.
 */

const h = probeHelpers();
const WHITE = { r: 255, g: 255, b: 255, a: 1 };
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

describe("the probe's colour and contrast helpers", () => {
  test("parseColor reads hex, rgb(), rgba(), the space syntax and transparent", () => {
    expect(h.parseColor("#fff")).toEqual(WHITE);
    expect(h.parseColor("#FFFFFF")).toEqual(WHITE);
    expect(h.parseColor("#00000080")).toEqual({ r: 0, g: 0, b: 0, a: 0.502 });
    expect(h.parseColor("rgb(29, 29, 27)")).toEqual({ r: 29, g: 29, b: 27, a: 1 });
    expect(h.parseColor("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(h.parseColor("rgb(255 0 0 / 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 0.5 });
    expect(h.parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(h.parseColor("color(display-p3 1 0 0)")).toBeNull();
    expect(h.parseColor("#12")).toBeNull();
  });

  test("assumption: contrast matches WCAG's reference values", () => {
    expect(h.contrastRatio(BLACK, WHITE)).toBe(21);
    expect(h.contrastRatio(WHITE, WHITE)).toBe(1);
    // #777 on white is the classic just-fails-AA grey.
    const grey = h.contrastRatio(h.parseColor("#777")!, WHITE);
    expect(grey).toBeGreaterThan(4.47);
    expect(grey).toBeLessThan(4.5);
    expect(h.contrastRatio(h.parseColor("#767676")!, WHITE)).toBeGreaterThanOrEqual(4.5);
  });

  test("large text (24px, or 18.66px bold) needs 3:1, other text 4.5:1", () => {
    expect(h.requiredContrast(16, 400)).toBe(4.5);
    expect(h.requiredContrast(24, 400)).toBe(3);
    expect(h.requiredContrast(19, 700)).toBe(3);
    expect(h.requiredContrast(19, 600)).toBe(4.5);
    expect(h.isLargeText(18.66, 700)).toBe(true);
  });

  test("a translucent colour blends over what is under it", () => {
    expect(h.blend({ r: 0, g: 0, b: 0, a: 0.5 }, WHITE)).toEqual({ r: 128, g: 128, b: 128, a: 1 });
    expect(h.blend({ r: 0, g: 0, b: 0, a: 0 }, WHITE)).toEqual(WHITE);
  });
});

describe("the probe's token comparison", () => {
  const inventory = {
    colors: [
      { value: "rgba(255, 255, 255, 1)", count: 4, examples: ["main"] },
      { value: "rgba(255, 0, 0, 1)", count: 1, examples: ["button.danger"] },
    ],
    fontFamilies: [{ value: "inter", count: 9, examples: ["p"] }],
    fontSizes: [
      { value: "15px", count: 6, examples: ["p"] },
      { value: "17px", count: 1, examples: ["h3"] },
    ],
    radii: [{ value: "8px", count: 2, examples: [".card"] }],
  };

  test("assumption: equal colours written differently compare equal; values outside the tokens are flagged", () => {
    const off = h.offTokens(inventory, { colors: ["#FFF", "#1d1d1b"], fontFamilies: ['"Inter", system-ui, sans-serif'], fontSizes: ["15px", "1.25rem"], radii: ["8px"] });
    expect(off).toEqual([
      { kind: "colors", value: "rgba(255, 0, 0, 1)", count: 1, examples: ["button.danger"] },
      { kind: "fontSizes", value: "17px", count: 1, examples: ["h3"] },
    ]);
  });

  test("a kind the tokens do not define is not compared, and no tokens means no comparison", () => {
    expect(h.offTokens(inventory, { radii: ["4px"] })).toEqual([{ kind: "radii", value: "8px", count: 2, examples: [".card"] }]);
    expect(h.offTokens(inventory, null)).toBeNull();
    expect(h.offTokens(inventory, undefined)).toBeNull();
  });

  test("lengths compare in px, rem at 16px", () => {
    expect(h.normLength("1.25rem")).toBe("20px");
    expect(h.normLength("20px")).toBe("20px");
    expect(h.primaryFamily('"SF Pro Text", -apple-system')).toBe("sf pro text");
  });
});

describe("the probe file", () => {
  test("it is one function expression chrome-devtools-axi can evaluate", () => {
    const fn = new Function(`return ${QA_PROBE}`)() as unknown;
    expect(typeof fn).toBe("function");
    expect(QA_PROBE.trimStart().startsWith("() => {")).toBe(true);
  });

  test("it never throws: outside a page it returns the error as data", () => {
    const fn = new Function(`return ${QA_PROBE}`)() as () => unknown;
    expect(fn()).toEqual({ error: expect.any(String) });
  });

  test("assumption: it reads no cookies or storage and makes no requests", () => {
    for (const banned of ["fetch(", "XMLHttpRequest", "document.cookie", "localStorage", "sessionStorage", "indexedDB", "sendBeacon", "WebSocket", "navigator.credentials"]) {
      expect(QA_PROBE).not.toContain(banned);
    }
  });

  test("it reads the tokens from the global the method sets, and caps its lists", () => {
    expect(QA_PROBE).toContain(`window["${QA_TOKENS_GLOBAL}"]`);
    expect(QA_PROBE).toContain(`const MAX = ${QA_PROBE_LIST_MAX};`);
  });
});
