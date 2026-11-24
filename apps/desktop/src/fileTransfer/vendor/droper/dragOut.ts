// Copyright (c) 2026 maksimliakhavets — MIT (see LICENSE).
// Upstream: Phoenix124/droper d3cf56d01c83a1c04e751e9adf2eccc295f6338c
export type DragOperation = 'none' | 'copy' | 'move' | 'link' | 'generic';
export interface DragOutResult {
  operation: DragOperation;
  endedOnShelf: boolean;
  removeAfterDragOut: boolean;
}
export function shouldRemoveAfterDragOut(r: DragOutResult): boolean {
  return r.removeAfterDragOut && !r.endedOnShelf && r.operation !== 'none';
}
