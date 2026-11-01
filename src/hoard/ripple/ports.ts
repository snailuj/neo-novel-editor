// What ripple needs from the parts that decide ownership and keep marks: review/owner.ts
// and marks/store.ts satisfy these shapes, and tests may stand in for them.
import type { Owner } from '../review/owner.ts';
import type { Mark, MarkAnchor, MarkKind } from '../../generated/hoard-marks-v1.js';

export type { Owner } from '../review/owner.ts';

/** Who owns a page, by its id (`<tree>/<path>`), for a library root. */
export type OwnerOf = (root: string, page: string) => Promise<Owner>;

export interface RippleMarkRequest {
  /** The page's id. */
  page: string;
  kind: MarkKind;
  anchor: Omit<MarkAnchor, 'commit'>;
  body?: string;
  proposed?: string;
}

export interface RippleMarks {
  add(req: RippleMarkRequest, who: 'librarian'): Promise<unknown>;
  /** A page's marks now. */
  list(page: string): Promise<Mark[]>;
}
