export interface Taggable {
  id: string;
  updated?: string;
  tags?: string[];
  appliedEventIds?: string[];
  files?: ({
    filepath: string;
  } & Record<string, unknown>)[];
}