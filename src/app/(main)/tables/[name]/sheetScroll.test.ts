import { describe, expect, it } from "vitest";
import { MAX_BODY_PX, bodyHeightFor, shiftWindow } from "./sheetScroll";

const ROW = 32;
const VIEW = 900;

/** Scroll down (or up) `px` at a time, as a wheel would, moving the window as the sheet does. */
function scroll(state: { offset: number; scrollTop: number }, px: number, steps: number, contentPx: number) {
  let s = { ...state };
  let moves = 0;
  for (let i = 0; i < steps; i++) {
    const before = s.offset + s.scrollTop;
    const height = bodyHeightFor(contentPx, s.offset);
    s.scrollTop = Math.max(0, Math.min(height - VIEW, s.scrollTop + px));
    const moved = shiftWindow({ ...s, viewPx: VIEW, contentPx, rowPx: ROW });
    if (moved) {
      moves++;
      // Nothing on screen moves: the row at the top of the view stays at the top.
      expect(moved.offset + moved.scrollTop).toBe(s.offset + s.scrollTop);
      s = moved;
    }
    expect(s.offset + s.scrollTop).toBe(Math.max(0, Math.min(contentPx - VIEW, before + px)));
    expect(s.offset % ROW).toBe(0);
  }
  return { ...s, moves };
}

describe("sheetScroll — a table taller than a browser will draw", () => {
  it("never makes the scrolling box taller than MAX_BODY_PX", () => {
    expect(bodyHeightFor(10 * ROW, 0)).toBe(10 * ROW);
    expect(bodyHeightFor(5_000_000 * ROW, 0)).toBe(MAX_BODY_PX);
    expect(bodyHeightFor(5_000_000 * ROW, 5_000_000 * ROW - 100)).toBe(100);
  });

  it("leaves a table that fits alone", () => {
    expect(shiftWindow({ offset: 0, scrollTop: 3_000_000, viewPx: VIEW, contentPx: 3_500_000, rowPx: ROW })).toBeNull();
  });

  it("scrolls one to one through five million rows and back, moving the window without moving the view", () => {
    const contentPx = 5_000_000 * ROW; // 160 million px — far past any browser's limit
    const down = scroll({ offset: 0, scrollTop: 0 }, 400_000, 400, contentPx);
    expect(down.offset + down.scrollTop).toBe(contentPx - VIEW);
    expect(down.moves).toBeGreaterThan(70);
    const up = scroll(down, -400_000, 400, contentPx);
    expect(up.offset + up.scrollTop).toBe(0);
    expect(up.offset).toBe(0);
  });

  it("doesn't bounce between the edges after a move", () => {
    const contentPx = 1_000_000 * ROW;
    const moved = shiftWindow({ offset: 0, scrollTop: MAX_BODY_PX - 400_000, viewPx: VIEW, contentPx, rowPx: ROW })!;
    expect(moved).not.toBeNull();
    expect(shiftWindow({ ...moved, viewPx: VIEW, contentPx, rowPx: ROW })).toBeNull();
    const back = shiftWindow({ ...moved, scrollTop: 100_000, viewPx: VIEW, contentPx, rowPx: ROW })!;
    expect(shiftWindow({ ...back, viewPx: VIEW, contentPx, rowPx: ROW })).toBeNull();
  });
});
