import { describe, expect, it } from "vitest";
import { wheelZooms } from "./wheelZoom";

const el = (enlarged: boolean) => ({ closest: (sel: string) => (sel === "[data-expanded]" && enlarged ? {} : null) }) as unknown as Element;
const wheel = (mods: Partial<WheelEvent> = {}) => ({ ctrlKey: false, metaKey: false, ...mods }) as WheelEvent;

describe("wheelZooms — when the mouse wheel zooms a chart", () => {
  it("zooms with Ctrl/⌘ (or a pinch) anywhere", () => {
    expect(wheelZooms(wheel({ ctrlKey: true }), el(false), false)).toBe(true);
    expect(wheelZooms(wheel({ metaKey: true }), el(false), false)).toBe(true);
  });
  it("zooms with a plain wheel when enlarged, or once clicked into", () => {
    expect(wheelZooms(wheel(), el(true), false)).toBe(true);
    expect(wheelZooms(wheel(), el(false), true)).toBe(true);
  });
  it("leaves a plain wheel to scroll the page past a chart nobody clicked", () => {
    expect(wheelZooms(wheel(), el(false), false)).toBe(false);
  });
});
