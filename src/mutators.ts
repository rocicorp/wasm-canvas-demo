// The application-facing write API.
//
// Rindle mutators describe keyed intents: an update carries the primary key plus only the columns
// that changed. Callers never fetch or send an old row. This demo has no sync server, so Writer
// drives the same generator locally and adapts its MutationOps to the older raw WASM Store seam.
// That adapter is the only place where a full old/new pair is ever assembled.

import {
  defineMutators,
  driveMutationSync,
  isoTx,
  type ArgSchema,
  type MutationGen,
  type MutationOp,
} from "@rindle/client";

import type { LayerRow, ShapeRow } from "./mirror.ts";
import { schema } from "./schema.ts";

export type ShapeChanges = Partial<
  Pick<ShapeRow, "x" | "y" | "w" | "h" | "rot" | "color" | "who" | "z">
>;
export type ShapeUpdate = { id: number } & ShapeChanges;

export interface CanvasFrameArgs {
  shapeAdds?: readonly ShapeRow[];
  shapeUpdates?: readonly ShapeUpdate[];
  shapeRemoves?: readonly number[];
  layerAdds?: readonly LayerRow[];
  layerUpdates?: ReadonlyArray<{ id: number; visible: number }>;
  selectionAdds?: readonly number[];
  selectionRemoves?: readonly number[];
}

/** The demo is entirely local and every caller is TypeScript, so this validator is intentionally
 *  only a typed identity. A synced app must use a real runtime validator here because the server
 *  parses untrusted wire arguments through this exact property. */
const localArgs: ArgSchema<CanvasFrameArgs> = {
  parse(raw: unknown): CanvasFrameArgs {
    return raw as CanvasFrameArgs;
  },
};

const { shared } = defineMutators(schema);

/** One named mutation per animation frame. A drag involving twenty shapes and a robot tick are
 *  each still one atomic mutation, but every update is only `{ id, ...changedColumns }`. */
export const mutators = {
  canvasFrame: shared(localArgs, function* (tx, args): MutationGen {
    for (const row of args.shapeAdds ?? []) yield tx.insert("shape", row);
    for (const update of args.shapeUpdates ?? []) yield tx.update("shape", update);
    for (const id of args.shapeRemoves ?? []) yield tx.delete("shape", { id });

    for (const row of args.layerAdds ?? []) yield tx.insert("layer", row);
    for (const { id, visible } of args.layerUpdates ?? []) {
      yield tx.update("layer", { id, visible });
    }

    for (const shape of args.selectionAdds ?? []) yield tx.insert("selection", { shape });
    for (const shape of args.selectionRemoves ?? []) yield tx.delete("selection", { shape });
  }),
};

/** Drive the named mutator with the same synchronous effect protocol used by an optimistic browser
 *  client. The raw local engine adapter consumes the resulting ops immediately afterward. */
export function runCanvasFrame(args: CanvasFrameArgs): MutationOp[] {
  const ops: MutationOp[] = [];
  driveMutationSync(mutators.canvasFrame(isoTx, args, { user: "local-demo" }), {
    apply: (op) => ops.push(op),
    read: () => {
      throw new Error("canvasFrame does not read rows");
    },
    query: () => {
      throw new Error("canvasFrame does not query rows");
    },
  });
  return ops;
}
