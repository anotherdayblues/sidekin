export function loadMemory(id: string): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem("pet-rules:" + id) ?? "{}");
  } catch {
    return {};
  }
}
export function saveMemory(id: string, memory: Record<string, number>) {
  try {
    localStorage.setItem("pet-rules:" + id, JSON.stringify(memory));
  } catch {
    // Rule timing still works for this session.
  }
}
