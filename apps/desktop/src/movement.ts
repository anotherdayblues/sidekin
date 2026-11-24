import type { Action } from "./animation.ts";
/** Original pointer threshold and direction selection, independent of native APIs. */
export class DragMotion {
  active = false;
  hasMoved = false;
  action: Action | null = null;
  private x = 0;
  private y = 0;
  begin(x: number, y: number) {
    this.active = true;
    this.hasMoved = false;
    this.action = null;
    this.x = x;
    this.y = y;
  }
  moved(x: number, y: number): Action | null {
    if (!this.active) return null;
    const dx = x - this.x,
      dy = y - this.y;
    if (Math.abs(dx) >= 4 || Math.abs(dy) >= 4) {
      this.hasMoved = true;
      this.x = x;
      this.y = y;
      if (dx >= 4) this.action = "running-right";
      else if (dx <= -4) this.action = "running-left";
    }
    return this.action;
  }
  end() {
    const moved = this.hasMoved;
    this.active = false;
    this.action = null;
    return moved;
  }
}
