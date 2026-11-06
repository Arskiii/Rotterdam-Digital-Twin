import type { MapPage } from "../ui/header";

/** One corridor identity across the retained workspaces; URL history owns persistence. */
export class StudySelection {
  private listeners = new Set<(id: string | null) => void>();
  constructor(public id: string | null, public open: (page: MapPage) => void) {}
  select(id: string | null) {
    if (id === this.id) return;
    this.id = id;
    for (const listener of this.listeners) listener(id);
  }
  subscribe(listener: (id: string | null) => void) {
    this.listeners.add(listener); listener(this.id);
    return () => { this.listeners.delete(listener); };
  }
}
