import { expect, test } from "@playwright/test";
import { remoteTextEdit, wireTextChunks } from "../src/remoteTextInput";

test("replaces the current Hangul syllable rather than appending its intermediate forms", () => {
  expect(remoteTextEdit("한글 이", "한글 입")).toEqual({ value: "한글 입", backspaces: 1, insertion: "입" });
});

test("counts a joined emoji as one Backspace", () => {
  expect(remoteTextEdit("a👨‍👩‍👧‍👦", "a🙂")).toEqual({ value: "a🙂", backspaces: 1, insertion: "🙂" });
});

test("normalizes WebKit nonbreaking input spaces without retyping the prefix", () => {
  expect(remoteTextEdit("한글 ", "한글\u00a0")).toEqual({ value: "한글 ", backspaces: 0, insertion: "" });
});

test("splits wire text without breaking surrogate pairs and keeps Enter separate", () => {
  const text = "a".repeat(1023) + "🙂";
  const chunks = wireTextChunks(text);
  expect(chunks.every((chunk) => chunk.length <= 1024)).toBe(true);
  expect(chunks.join("")).toBe(text);
  expect(wireTextChunks("한글\n🙂")).toEqual(["한글", "\n", "🙂"]);
});
