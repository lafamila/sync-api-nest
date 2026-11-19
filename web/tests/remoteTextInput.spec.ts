import { expect, test } from "@playwright/test";
import { keyboardBufferTail, remoteTextEdit, wireTextChunks } from "../src/remoteTextInput";

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

test("bounds long keyboard capture buffers without breaking a composed grapheme", () => {
  const family = "👨‍👩‍👧‍👦";
  expect(keyboardBufferTail("a".repeat(5000) + family)).toBe("a".repeat(255) + family);
  expect(keyboardBufferTail("한글")).toBe("한글");
  expect(keyboardBufferTail("a" + "\u0300".repeat(5000))).toBe("");
  expect(remoteTextEdit(keyboardBufferTail("a".repeat(5000) + family), "a".repeat(255) + "🙂"))
    .toEqual({ value: "a".repeat(255) + "🙂", backspaces: 1, insertion: "🙂" });
});
