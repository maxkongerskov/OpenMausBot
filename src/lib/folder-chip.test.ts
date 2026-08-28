import { describe, expect, it } from "vitest";
import { folderChipLabel } from "./folder-chip";

describe("folderChipLabel", () => {
  it("hides empty, home, workspace UUID dirs, and the app workspaces tree", () => {
    expect(folderChipLabel(undefined)).toBeNull();
    expect(folderChipLabel("")).toBeNull();
    expect(folderChipLabel("/Users/max", "/Users/max")).toBeNull();
    expect(folderChipLabel("/Users/maxkongerskov/.openmausbot/workspaces/b46feeac-90d5-4861-979c-40ae66a36b75")).toBeNull();
    expect(folderChipLabel("C:\\Users\\max\\.openmausbot\\workspaces\\b46feeac-90d5-4861-979c-40ae66a36b75")).toBeNull();
    expect(folderChipLabel("/tmp/b46feeac-90d5-4861-979c-40ae66a36b75")).toBeNull();
  });

  it("shows a real project folder name", () => {
    expect(folderChipLabel("/Users/max/orca/workspaces/OpenMausBot/Development")).toBe("Development");
    expect(folderChipLabel("/Users/max/Downloads/Flowa", "/Users/max")).toBe("Flowa");
  });
});
