// Matchers the tests use that Vitest doesn't ship: a string's start and end, as Bun's test runner has
// them. Importing this file adds them.
import { expect } from "vitest";

declare module "vitest" {
  interface Matchers<R, T> {
    toStartWith(prefix: string): R;
    toEndWith(suffix: string): R;
  }
}

type State = {
  isNot: boolean;
  utils: { printReceived(value: unknown): string; printExpected(value: unknown): string };
};

const matcher = (name: string, test: (text: string, part: string) => boolean) =>
  function (this: State, received: unknown, part: string) {
    return {
      pass: typeof received === "string" && test(received, part),
      message: () =>
        `expected ${this.utils.printReceived(received)} ${this.isNot ? "not " : ""}${name} ` +
        this.utils.printExpected(part),
    };
  };

expect.extend({
  toStartWith: matcher("to start with", (text, part) => text.startsWith(part)),
  toEndWith: matcher("to end with", (text, part) => text.endsWith(part)),
});
