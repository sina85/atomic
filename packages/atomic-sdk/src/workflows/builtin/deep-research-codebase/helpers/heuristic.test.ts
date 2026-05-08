import { test, expect, describe } from "bun:test";
import {
  calculateExplorerCount,
  CODEGRAPH_EXPLORER_FACTOR,
} from "./heuristic";

describe("CODEGRAPH_EXPLORER_FACTOR", () => {
  test("exported value === 0.7", () => {
    expect(CODEGRAPH_EXPLORER_FACTOR).toBe(0.7);
  });
});

describe("calculateExplorerCount — edge inputs", () => {
  test("loc=0 → 2", () => {
    expect(calculateExplorerCount(0)).toBe(2);
  });

  test("loc=-1 → 2", () => {
    expect(calculateExplorerCount(-1)).toBe(2);
  });

  test("loc=NaN → 2", () => {
    expect(calculateExplorerCount(NaN)).toBe(2);
  });

  test("loc=0 codegraphHealthy:true → 2", () => {
    expect(calculateExplorerCount(0, { codegraphHealthy: true })).toBe(2);
  });

  test("loc=-1 codegraphHealthy:true → 2", () => {
    expect(calculateExplorerCount(-1, { codegraphHealthy: true })).toBe(2);
  });

  test("loc=NaN codegraphHealthy:true → 2", () => {
    expect(calculateExplorerCount(NaN, { codegraphHealthy: true })).toBe(2);
  });
});

describe("calculateExplorerCount — small LOC (min-2 floor)", () => {
  // loc=1000: base=ceil(1000/5000)=1 → max(2,1)=2
  test("loc=1000 no opts → 2", () => {
    expect(calculateExplorerCount(1000)).toBe(2);
  });

  // healthy: max(2, ceil(2×0.7))=max(2, ceil(1.4))=max(2,2)=2
  test("loc=1000 codegraphHealthy:true → 2", () => {
    expect(calculateExplorerCount(1000, { codegraphHealthy: true })).toBe(2);
  });

  test("loc=1000 codegraphHealthy:false → 2", () => {
    expect(calculateExplorerCount(1000, { codegraphHealthy: false })).toBe(2);
  });
});

describe("calculateExplorerCount — medium LOC", () => {
  // loc=10_000: base=ceil(10000/5000)=2 → max(2,2)=2
  test("loc=10_000 no opts → 2", () => {
    expect(calculateExplorerCount(10_000)).toBe(2);
  });

  // healthy: max(2, ceil(2×0.7))=max(2, ceil(1.4))=max(2,2)=2
  test("loc=10_000 codegraphHealthy:true → 2", () => {
    expect(calculateExplorerCount(10_000, { codegraphHealthy: true })).toBe(2);
  });

  test("loc=10_000 codegraphHealthy:false → 2", () => {
    expect(calculateExplorerCount(10_000, { codegraphHealthy: false })).toBe(2);
  });

  // loc=25_000: base=ceil(25000/5000)=5 → max(2,5)=5
  test("loc=25_000 no opts → 5", () => {
    expect(calculateExplorerCount(25_000)).toBe(5);
  });

  // healthy: max(2, ceil(5×0.7))=max(2, ceil(3.5))=max(2,4)=4
  test("loc=25_000 codegraphHealthy:true → 4", () => {
    expect(calculateExplorerCount(25_000, { codegraphHealthy: true })).toBe(4);
  });

  test("loc=25_000 codegraphHealthy:false → 5", () => {
    expect(calculateExplorerCount(25_000, { codegraphHealthy: false })).toBe(5);
  });
});

describe("calculateExplorerCount — large LOC", () => {
  // loc=100_000: base=ceil(100000/5000)=20 → max(2,20)=20
  test("loc=100_000 no opts → 20", () => {
    expect(calculateExplorerCount(100_000)).toBe(20);
  });

  // healthy: max(2, ceil(20×0.7))=max(2,14)=14
  test("loc=100_000 codegraphHealthy:true → 14", () => {
    expect(calculateExplorerCount(100_000, { codegraphHealthy: true })).toBe(14);
  });

  test("loc=100_000 codegraphHealthy:false → 20", () => {
    expect(calculateExplorerCount(100_000, { codegraphHealthy: false })).toBe(20);
  });
});

describe("calculateExplorerCount — ceil rounding on factor multiplication", () => {
  // base=3 → ceil(3×0.7)=ceil(2.1)=3 (still ≥ 2)
  // loc=15_000: base=ceil(15000/5000)=3
  test("loc=15_000 codegraphHealthy:true → ceil(3×0.7)=ceil(2.1)=3", () => {
    expect(calculateExplorerCount(15_000, { codegraphHealthy: true })).toBe(3);
  });

  test("loc=15_000 no opts → 3", () => {
    expect(calculateExplorerCount(15_000)).toBe(3);
  });
});

describe("calculateExplorerCount — no opts (default)", () => {
  test("no opts arg same as codegraphHealthy:false for loc=25_000", () => {
    expect(calculateExplorerCount(25_000)).toBe(
      calculateExplorerCount(25_000, { codegraphHealthy: false }),
    );
  });

  test("no opts arg same as codegraphHealthy:false for loc=100_000", () => {
    expect(calculateExplorerCount(100_000)).toBe(
      calculateExplorerCount(100_000, { codegraphHealthy: false }),
    );
  });
});
