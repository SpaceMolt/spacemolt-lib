import { describe, expect, test } from "bun:test";
import { Account } from "../src/index.ts";

describe("Account.id", () => {
  test("exposes the id it was constructed with", () => {
    const account = new Account({ id: "Player1" });
    expect(account.id).toBe("Player1");
  });

  test("is undefined when no id was provided", () => {
    const account = new Account({});
    expect(account.id).toBeUndefined();
  });
});
