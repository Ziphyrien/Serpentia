import { describe, expect, it } from "vite-plus/test";
import { nextNetworkInput } from "./network-input";

const EPSILON = 0.02;

describe("network input command", () => {
  it("uses the authoritative heading for boost before the first steering gesture", () => {
    const command = nextNetworkInput(
      { angle: 0, boosting: true, hasDirection: false },
      Math.PI / 3,
      { angle: undefined, boosting: false },
      EPSILON,
    );

    expect(command).toEqual({ angle: Math.PI / 3, boosting: true });
  });

  it("sends a boost release even when no steering direction exists", () => {
    const command = nextNetworkInput(
      { angle: 0, boosting: false, hasDirection: false },
      -Math.PI / 4,
      { angle: -Math.PI / 4, boosting: true },
      EPSILON,
    );

    expect(command).toEqual({ angle: -Math.PI / 4, boosting: false });
  });

  it("does not send an idle command before direction or boost input", () => {
    const command = nextNetworkInput(
      { angle: 0, boosting: false, hasDirection: false },
      Math.PI / 2,
      { angle: undefined, boosting: false },
      EPSILON,
    );

    expect(command).toBeUndefined();
  });

  it("uses local steering once it becomes available", () => {
    const command = nextNetworkInput(
      { angle: 0.75, boosting: false, hasDirection: true },
      -1,
      { angle: 0, boosting: false },
      EPSILON,
    );

    expect(command).toEqual({ angle: 0.75, boosting: false });
  });
});
