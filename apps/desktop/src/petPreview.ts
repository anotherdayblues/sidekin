import { listen } from "@tauri-apps/api/event";
import type { SpritePlayer } from "./player.ts";
import type { Step } from "./teaching.ts";
import * as api from "./bridge.ts";
export function petPreviews(
  player: SpritePlayer,
  read: () => { snapshot: api.Snapshot; rulesPet: string },
  clickOnly: () => boolean,
  runSequence: (steps: Step[], source: string) => void,
) {
  return listen<api.Preview>("preview-steps", async (e) => {
    if (clickOnly()) return;
    const { snapshot, rulesPet } = read();
    const preview = e.payload,
      draft = snapshot.drafts.find((d) => d.id === preview.draftId);
    if (preview.petId !== rulesPet) return;
    if (draft) {
      const entries = await Promise.all(
        draft.addedActions.map(
          async (name) =>
            [
              name,
              {
                ...draft.preview.actions[name],
                url: await api.actionImage(draft.petId, name, draft.id),
              },
            ] as const,
        ),
      );
      await player.addClips(Object.fromEntries(entries));
    }
    runSequence(preview.steps, "preview");
  });
}
