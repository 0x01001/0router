import { describe, expect, it } from "vitest";
import {
  formatDisplayVersion,
  parseLocalPatchNumber,
} from "../../src/shared/utils/localReleaseVersion";

describe("local release version", () => {
  it.each([
    [undefined, 0],
    ["", 0],
    ["0", 0],
    ["-1", 0],
    ["invalid", 0],
    ["2oops", 0],
    ["1.5", 0],
    ["1", 1],
    ["3", 3],
  ])("parses patch number %j as %i", (input, expected) => {
    expect(parseLocalPatchNumber(input)).toBe(expected);
  });

  it("keeps the semantic version unchanged when no local patch exists", () => {
    expect(formatDisplayVersion("0.5.59", 0)).toBe("0.5.59");
  });

  it("adds the local patch label for visible version text", () => {
    expect(formatDisplayVersion("0.5.59", 3)).toBe("0.5.59 patch #3");
  });
});
