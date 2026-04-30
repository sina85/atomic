import { describe, expect, test } from "bun:test";
import { mergeTerminalEnv, normalizedTerminalEnv } from "./terminal-env.ts";

describe("normalizedTerminalEnv", () => {
  test("missing locale defaults to en_US.UTF-8", () => {
    const env = normalizedTerminalEnv({});
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["LC_ALL"]).toBe("en_US.UTF-8");
    expect(env["LC_CTYPE"]).toBe("en_US.UTF-8");
  });

  test("existing UTF-8 locale is preserved", () => {
    const base = { LANG: "en_GB.UTF-8", LC_ALL: "fr_FR.utf8", LC_CTYPE: "C.UTF-8" };
    const env = normalizedTerminalEnv(base);
    expect(env["LANG"]).toBe("en_GB.UTF-8");
    expect(env["LC_ALL"]).toBe("fr_FR.utf8");
    expect(env["LC_CTYPE"]).toBe("C.UTF-8");
  });

  test("non-UTF-8 locale is replaced with en_US.UTF-8", () => {
    const base = { LANG: "en_US.ISO-8859-1", LC_ALL: "C", LC_CTYPE: "POSIX" };
    const env = normalizedTerminalEnv(base);
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["LC_ALL"]).toBe("en_US.UTF-8");
    expect(env["LC_CTYPE"]).toBe("en_US.UTF-8");
  });

  test("TERM=dumb becomes xterm-256color", () => {
    const env = normalizedTerminalEnv({ TERM: "dumb" });
    expect(env["TERM"]).toBe("xterm-256color");
  });

  test("missing TERM defaults to xterm-256color", () => {
    const env = normalizedTerminalEnv({});
    expect(env["TERM"]).toBe("xterm-256color");
  });

  test("explicit COLORTERM is preserved", () => {
    const env = normalizedTerminalEnv({ COLORTERM: "24bit" });
    expect(env["COLORTERM"]).toBe("24bit");
  });

  test("missing COLORTERM defaults to truecolor", () => {
    const env = normalizedTerminalEnv({});
    expect(env["COLORTERM"]).toBe("truecolor");
  });

  test("other env vars carried through unchanged", () => {
    const env = normalizedTerminalEnv({ HOME: "/root", PATH: "/usr/bin" });
    expect(env["HOME"]).toBe("/root");
    expect(env["PATH"]).toBe("/usr/bin");
  });

  test("undefined values dropped", () => {
    const base: NodeJS.ProcessEnv = { SOME_VAR: undefined };
    const env = normalizedTerminalEnv(base);
    expect("SOME_VAR" in env).toBe(false);
  });
});

describe("mergeTerminalEnv", () => {
  test("explicit env vars win over defaults", () => {
    const env = mergeTerminalEnv(
      { LANG: "ja_JP.UTF-8", TERM: "screen", COLORTERM: "256" },
      {},
    );
    expect(env["LANG"]).toBe("ja_JP.UTF-8");
    expect(env["TERM"]).toBe("screen");
    expect(env["COLORTERM"]).toBe("256");
  });

  test("missing keys still get sane defaults", () => {
    const env = mergeTerminalEnv({}, {});
    expect(env["LANG"]).toBe("en_US.UTF-8");
    expect(env["TERM"]).toBe("xterm-256color");
    expect(env["COLORTERM"]).toBe("truecolor");
  });

  test("explicit vars merged on top of baseEnv normalization", () => {
    const base = { LANG: "C", TERM: "dumb" };
    const env = mergeTerminalEnv({ LANG: "de_DE.UTF-8" }, base);
    // explicit wins
    expect(env["LANG"]).toBe("de_DE.UTF-8");
    // TERM=dumb normalized then no override → xterm-256color
    expect(env["TERM"]).toBe("xterm-256color");
  });
});
