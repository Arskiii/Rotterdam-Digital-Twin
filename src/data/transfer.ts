/** Transfer every backing store once, including buffers shared by several views. */
export function transferableBuffers(value: unknown): ArrayBuffer[] {
  const result = new Set<ArrayBuffer>();
  const visit = (item: unknown) => {
    if (item instanceof ArrayBuffer) result.add(item);
    else if (ArrayBuffer.isView(item)) result.add(item.buffer as ArrayBuffer);
    else if (item && typeof item === "object") for (const child of Object.values(item)) visit(child);
  };
  visit(value); return [...result];
}
