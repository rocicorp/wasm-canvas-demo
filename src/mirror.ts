// The same rows, in one plain JS Map.
//
// The mirror holds the app-side state used by gestures, history, and selection. Application writes
// are keyed patches and do not carry an old row. Only the terminal adapter to this demo's raw local
// WASM engine resolves a patch here into the full old/new delta that engine consumes; a synced
// Rindle client performs that resolution internally.

export interface ShapeRow {
  id: number;
  kind: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rotation about the centre, radians. Nothing maintained depends on it — see `schema.ts`. */
  rot: number;
  color: string;
  z: number;
  area: number;
  updated: number;
  who: number;
  layer: number;
  /** The shape's cell at each zoom level, from its CENTRE — see `cell.ts`. Maintained on every
   *  write that moves the row, exactly as `area` is maintained on every write that resizes it.
   *  The canvas subscribes one query per visible cell, so these are what put a row on screen. */
  c0: number;
  c1: number;
  c2: number;
  c3: number;
}

export interface LayerRow {
  id: number;
  name: string;
  visible: number;
}

/** One row of the `selection` table — a shape id, and nothing else. */
export interface SelectionRow {
  shape: number;
}

export class Mirror {
  private readonly rows = new Map<number, ShapeRow>();
  private readonly layerRows = new Map<number, LayerRow>();
  private readonly selectedIds = new Set<number>();

  get size(): number {
    return this.rows.size;
  }

  get(id: number): ShapeRow | undefined {
    return this.rows.get(id);
  }

  /** Iterate every shape row. */
  all(): IterableIterator<ShapeRow> {
    return this.rows.values();
  }

  add(row: ShapeRow): void {
    this.rows.set(row.id, row);
  }

  edit(next: ShapeRow): void {
    this.rows.set(next.id, next);
  }

  remove(id: number): void {
    this.rows.delete(id);
  }

  // -- layers -----------------------------------------------------------------------------------

  addLayer(row: LayerRow): void {
    this.layerRows.set(row.id, row);
  }

  editLayer(next: LayerRow): void {
    this.layerRows.set(next.id, next);
  }

  getLayer(id: number): LayerRow | undefined {
    return this.layerRows.get(id);
  }

  allLayers(): IterableIterator<LayerRow> {
    return this.layerRows.values();
  }

  /** Whether this shape's layer is visible. */
  visibleLayer(id: number): boolean {
    return (this.layerRows.get(id)?.visible ?? 0) === 1;
  }

  // -- selection --------------------------------------------------------------------------------

  /** Whether this shape is selected. */
  isSelected(id: number): boolean {
    return this.selectedIds.has(id);
  }

  get selectionSize(): number {
    return this.selectedIds.size;
  }

  addSelection(shape: number): void {
    this.selectedIds.add(shape);
  }

  removeSelection(shape: number): void {
    this.selectedIds.delete(shape);
  }
}
